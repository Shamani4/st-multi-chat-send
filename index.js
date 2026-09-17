import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    characters,
    chat,
    this_chid,
    setCharacterId,
    setCharacterName,
    openCharacterChat,
    sendTextareaMessage,
    sendMessageAsUser,
    unshallowCharacter,
    stopGeneration,
    getThumbnailUrl,
    getRequestHeaders,
    is_send_press,
} from '../../../../script.js';
import { selected_group } from '../../../group-chats.js';
import { getLastApiUsage } from '../../../openai.js';
import { Popup, POPUP_TYPE } from '../../../popup.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { timestampToMoment, sortMoments } from '../../../utils.js';

const MODULE_NAME = 'st-multi-chat-send';
const EXTENSION_ROUTE = 'third-party/st-multi-chat-send';
const SETTINGS_KEY = 'multi_chat_send';

const DEFAULT_SETTINGS = {
    return_to_original_chat: true,
    generate_replies: true,
    exclude_current_chat: true,
};

const log = (...args) => console.log(`[${MODULE_NAME}]`, ...args);

/** @type {{ running: boolean, abortRequested: boolean, popup: Popup|null }} */
const state = { running: false, abortRequested: false, popup: null };

function getSettings() {
    return extension_settings[SETTINGS_KEY];
}

function loadSettings() {
    extension_settings[SETTINGS_KEY] = extension_settings[SETTINGS_KEY] || {};
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (extension_settings[SETTINGS_KEY][key] === undefined) {
            extension_settings[SETTINGS_KEY][key] = value;
        }
    }
}

function addWandButton() {
    if (document.getElementById('mcs_wand_button')) return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    const button = document.createElement('div');
    button.id = 'mcs_wand_button';
    button.classList.add('list-group-item', 'flex-container', 'flexGap5');
    const icon = document.createElement('div');
    icon.classList.add('fa-solid', 'fa-paper-plane', 'extensionsMenuExtensionButton');
    const label = document.createElement('span');
    label.textContent = 'Multi-Chat Send';
    button.append(icon, label);
    button.addEventListener('click', () => openMultiSendModal());
    menu.appendChild(button);
}

async function addSettingsBlock() {
    if (document.getElementById('mcs_settings')) return;
    const html = await renderExtensionTemplateAsync(EXTENSION_ROUTE, 'templates/settings');
    const settings = getSettings();
    const $block = $(html);
    $block.find('#mcs_setting_return').prop('checked', settings.return_to_original_chat)
        .on('change', function () {
            getSettings().return_to_original_chat = $(this).prop('checked');
            saveSettingsDebounced();
        });
    $block.find('#mcs_setting_generate').prop('checked', settings.generate_replies)
        .on('change', function () {
            getSettings().generate_replies = $(this).prop('checked');
            saveSettingsDebounced();
        });
    $block.find('#mcs_setting_exclude_current').prop('checked', settings.exclude_current_chat)
        .on('change', function () {
            getSettings().exclude_current_chat = $(this).prop('checked');
            saveSettingsDebounced();
        });
    $('#extensions_settings2').append($block);
}

function registerSlashCommand() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'multisend',
        aliases: ['mcs'],
        callback: async (_args, text) => {
            openMultiSendModal(String(text ?? ''));
            return '';
        },
        unnamedArgumentList: [
            new SlashCommandArgument(
                'текст сообщения (необязательно — по умолчанию берётся из поля ввода)',
                [ARGUMENT_TYPE.STRING],
                false,
                false,
                '',
            ),
        ],
        helpString: 'Открывает окно Multi-Chat Send: отправка одного сообщения сразу в несколько чатов (с генерацией ответов или без).',
    }));
}

async function fetchRecentCharacterChats() {
    const response = await fetch('/api/chats/recent', {
        method: 'POST',
        headers: getRequestHeaders(),
        credentials: 'same-origin',
        body: JSON.stringify({ max: 1000 }),
    });
    if (!response.ok) throw new Error(`/api/chats/recent: HTTP ${response.status}`);
    return response.json();
}

function buildTargets() {
    return fetchRecentCharacterChats().then((entries) => {
        const targets = [];
        for (const entry of entries) {
            if (!entry.avatar) continue; // групповые и «бездомные» чаты — вне v1
            const chId = characters.findIndex(c => c.avatar === entry.avatar);
            if (chId === -1) continue; // чат без живой карточки персонажа
            targets.push({
                chId,
                charName: characters[chId].name,
                chatFile: String(entry.file_name ?? '').replace(/\.jsonl$/, ''),
                lastMes: entry.last_mes,
                messageCount: entry.chat_items ?? entry.message_count ?? 0,
                preview: entry.preview_message ?? entry.mes ?? '',
            });
        }
        return targets.sort((a, b) => sortMoments(timestampToMoment(a.lastMes), timestampToMoment(b.lastMes)));
    });
}

function captureOriginalSession() {
    const chid = String(this_chid);
    if (chid === 'undefined' || !characters[Number(chid)]) return null;
    return { chId: chid, chatFile: characters[Number(chid)].chat || null };
}

async function restoreSession(original) {
    if (String(this_chid) !== original.chId) {
        setCharacterId(original.chId);
        setCharacterName(characters[original.chId].name);
    }
    if (original.chatFile) {
        await openCharacterChat(original.chatFile);
    }
}

/** Sentinel thrown inside sendToOne when the user pressed Stop before this target's send started. */
const CANCELLED = Symbol('mcs-cancelled');

async function sendToOne(target, text, generateReplies) {
    if (characters[target.chId]?.shallow) {
        await unshallowCharacter(target.chId);
    }
    if (String(this_chid) !== String(target.chId)) {
        setCharacterId(target.chId);
        setCharacterName(characters[target.chId].name);
    }
    await openCharacterChat(target.chatFile);
    // Stop мог прилететь, пока открывался чат (несколько сетевых раундов) — не отправляем
    if (state.abortRequested) throw CANCELLED;
    const lenBefore = chat.length;
    if (generateReplies) {
        $('#send_textarea').val(text).trigger('input');
        await sendTextareaMessage();
    } else {
        await sendMessageAsUser(text, null);
    }
    // sendTextareaMessage молча выходит, если генерация уже шла (is_send_press и т.п.) — ловим нулевой результат
    if (chat.length <= lenBefore) {
        throw new Error('сообщение не было отправлено (генерация не выполнилась)');
    }
    const usage = generateReplies ? getLastApiUsage() : null;
    const lastMes = chat[chat.length - 1];
    return {
        ...target,
        status: 'ok',
        cost: usage?.cost ?? null,
        currency: usage?.currency ?? null,
        provider: usage?.provider ?? lastMes?.extra?.api_provider ?? null,
        model: lastMes?.extra?.model ?? null,
    };
}

function buildRow(target, isCurrent) {
    const row = document.createElement('label');
    row.classList.add('mcs-chat-row');
    row.dataset.search = `${target.charName} ${target.chatFile} ${target.preview}`.toLowerCase();
    row.dataset.target = JSON.stringify(target);

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.classList.add('mcs-chat-check');

    const avatar = document.createElement('img');
    avatar.classList.add('mcs-avatar');
    avatar.src = getThumbnailUrl('avatar', target.avatar || characters[target.chId].avatar);

    const info = document.createElement('div');
    info.classList.add('mcs-info');
    const title = document.createElement('div');
    title.classList.add('mcs-title');
    const charSpan = document.createElement('span');
    charSpan.classList.add('mcs-char-name');
    charSpan.textContent = target.charName;
    const chatSpan = document.createElement('span');
    chatSpan.classList.add('mcs-chat-name');
    chatSpan.textContent = target.chatFile;
    title.append(charSpan, ' · ', chatSpan);
    if (isCurrent) {
        const badge = document.createElement('span');
        badge.classList.add('mcs-badge-current');
        badge.textContent = 'текущий';
        title.append(' ', badge);
    }
    const sub = document.createElement('div');
    sub.classList.add('mcs-sub');
    const date = timestampToMoment(target.lastMes);
    const dateText = date?.isValid?.() ? date.format('lll') : '';
    const preview = String(target.preview ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    sub.textContent = [dateText, `${target.messageCount} 💬`, preview && `«${preview}»`].filter(Boolean).join(' · ');
    info.append(title, sub);

    const status = document.createElement('span');
    status.classList.add('mcs-status');
    status.dataset.status = 'pending';
    status.title = '';

    row.append(check, avatar, info, status);
    return row;
}

async function waitForCharacters(timeoutMs = 10000) {
    const start = Date.now();
    while (!characters.length && Date.now() - start < timeoutMs) {
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    return characters.length > 0;
}

async function openMultiSendModal(prefillText = '') {
    if (state.running) {
        toastr.warning('Мульти-отправка уже выполняется', 'Multi-Chat Send');
        return;
    }
    if (selected_group) {
        toastr.warning('Из группового чата мульти-отправка недоступна. Откройте чат персонажа.', 'Multi-Chat Send');
        return;
    }
    if (is_send_press) {
        toastr.warning('Дождитесь окончания текущей генерации', 'Multi-Chat Send');
        return;
    }
    if (state.popup) {
        toastr.info('Окно Multi-Chat Send уже открыто', 'Multi-Chat Send');
        return;
    }
    if (!await waitForCharacters()) {
        toastr.error('Список персонажей ещё не загрузился, попробуйте ещё раз', 'Multi-Chat Send');
        return;
    }

    let targets;
    try {
        targets = await buildTargets();
    } catch (e) {
        toastr.error(`Не удалось получить список чатов: ${e.message}`, 'Multi-Chat Send');
        return;
    }

    const settings = getSettings();
    const currentChid = String(this_chid);
    const currentChatFile = currentChid !== 'undefined' && characters[Number(currentChid)]
        ? characters[Number(currentChid)].chat
        : null;
    const visibleTargets = targets.filter(t =>
        !(settings.exclude_current_chat && String(t.chId) === currentChid && t.chatFile === currentChatFile));
    if (!visibleTargets.length) {
        toastr.info('Не найдено чатов персонажей для отправки', 'Multi-Chat Send');
        return;
    }

    let html;
    try {
        html = await renderExtensionTemplateAsync(EXTENSION_ROUTE, 'templates/modal');
    } catch (e) {
        toastr.error(`Не удалось загрузить шаблон окна: ${e.message}`, 'Multi-Chat Send');
        return;
    }
    const $content = $(html);
    const $list = $content.find('#mcs_chat_list');
    const $count = $content.find('#mcs_selected_count');
    const $search = $content.find('#mcs_search');
    const $message = $content.find('#mcs_message');
    const $generateCheck = $content.find('#mcs_generate_reply');
    const $sendBtn = $content.find('#mcs_send_btn');
    const $cancelBtn = $content.find('#mcs_cancel_btn');
    const $stopBtn = $content.find('#mcs_stop_btn');
    const $closeBtn = $content.find('#mcs_close_btn');
    const $selectAllBtn = $content.find('#mcs_select_all');
    const $selectNoneBtn = $content.find('#mcs_select_none');
    const $progressWrap = $content.find('#mcs_progress_wrap');
    const $progressFill = $content.find('#mcs_progress_fill');
    const $progressText = $content.find('#mcs_progress_text');
    const $summary = $content.find('#mcs_summary');

    $message.val(String(prefillText || $('#send_textarea').val() || ''));
    $generateCheck.prop('checked', settings.generate_replies);

    for (const target of visibleTargets) {
        const isCurrent = String(target.chId) === currentChid && target.chatFile === currentChatFile;
        $list.append(buildRow(target, isCurrent));
    }

    const rows = () => [...$content.find('.mcs-chat-row')];
    const updateCount = () => {
        const checked = $content.find('.mcs-chat-check:checked').length;
        $count.text(`Выбрано: ${checked} из ${rows().length}`);
        $sendBtn.prop('disabled', checked === 0);
    };
    const setRowStatus = (row, statusName, result) => {
        const el = row.querySelector('.mcs-status');
        el.dataset.status = statusName;
        const labels = { pending: '', running: 'генерация…', ok: '✓', error: '✗', cancelled: 'отменено' };
        el.textContent = labels[statusName] ?? '';
        if (statusName === 'ok' && result) {
            const cost = result.cost != null ? formatCost(result.cost, result.currency) : '';
            el.textContent = `✓${cost ? ` ${cost}` : ''}`;
            el.title = [result.model, result.provider && `via ${result.provider}`].filter(Boolean).join(' ');
        }
        if (statusName === 'error' && result) {
            el.title = result.error ?? '';
        }
    };

    $list.on('change', '.mcs-chat-check', updateCount);
    updateCount();

    $search.on('input', () => {
        const q = String($search.val() || '').trim().toLowerCase();
        for (const row of rows()) {
            row.hidden = !!q && !row.dataset.search.includes(q);
        }
    });

    $selectAllBtn.on('click', () => {
        $content.find('.mcs-chat-row:not([hidden]) .mcs-chat-check').prop('checked', true);
        updateCount();
    });
    $selectNoneBtn.on('click', () => {
        $content.find('.mcs-chat-check').prop('checked', false);
        updateCount();
    });

    const popup = new Popup($content, POPUP_TYPE.TEXT, '', {
        okButton: false,
        cancelButton: false,
        wide: true,
        allowVerticalScrolling: true,
        allowEscapeClose: true,
        onClosing: () => !state.running,
    });
    state.popup = popup;

    const closeModal = (result) => popup.complete(result);

    // Все обработки вешаются ДО show(): await popup.show() разрешается только при закрытии окна
    $cancelBtn.on('click', () => closeModal(0));
    $closeBtn.on('click', () => closeModal(1));

    $stopBtn.on('click', () => {
        state.abortRequested = true;
        stopGeneration();
        $stopBtn.prop('disabled', true);
    });

    $sendBtn.on('click', async () => {
        if (state.running || is_send_press) {
            toastr.warning('Дождитесь окончания текущей генерации', 'Multi-Chat Send');
            return;
        }
        const text = String($message.val() || '').trim();
        if (!text) {
            toastr.warning('Введите текст сообщения', 'Multi-Chat Send');
            return;
        }
        const selectedRows = rows().filter(r => r.querySelector('.mcs-chat-check')?.checked);
        if (!selectedRows.length) {
            toastr.warning('Отметьте хотя бы один чат', 'Multi-Chat Send');
            return;
        }
        const generateReplies = $generateCheck.prop('checked');

        // состояние «прогресс»
        state.running = true;
        state.abortRequested = false;
        $sendBtn.add($cancelBtn).add($selectAllBtn).add($selectNoneBtn).add($search).add($message).add($generateCheck).prop('disabled', true);
        $content.find('.mcs-chat-check').prop('disabled', true);
        $sendBtn.hide();
        $cancelBtn.hide();
        $stopBtn.removeAttr('hidden');
        $progressWrap.removeAttr('hidden');
        for (const row of selectedRows) setRowStatus(row, 'pending');

        const original = captureOriginalSession();
        const results = [];
        for (let i = 0; i < selectedRows.length; i++) {
            const row = selectedRows[i];
            if (state.abortRequested) {
                setRowStatus(row, 'cancelled');
                results.push({ ...JSON.parse(row.dataset.target), status: 'cancelled' });
                continue;
            }
            $progressFill.css('width', `${(i / selectedRows.length) * 100}%`);
            $progressText.text(`${i + 1}/${selectedRows.length}`);
            setRowStatus(row, 'running');
            const target = JSON.parse(row.dataset.target);
            try {
                const result = await sendToOne(target, text, generateReplies);
                results.push(result);
                setRowStatus(row, 'ok', result);
            } catch (e) {
                if (e === CANCELLED) {
                    const result = { ...target, status: 'cancelled' };
                    results.push(result);
                    setRowStatus(row, 'cancelled');
                } else {
                    const result = { ...target, status: 'error', error: String(e?.message ?? e) };
                    results.push(result);
                    setRowStatus(row, 'error', result);
                }
            }
        }
        $progressFill.css('width', '100%');
        $progressText.text(`${selectedRows.length}/${selectedRows.length}`);

        let restoreError = null;
        if (settings.return_to_original_chat && original) {
            try {
                await restoreSession(original);
            } catch (e) {
                restoreError = String(e?.message ?? e);
            }
        }

        if (String($('#send_textarea').val() || '') === text) {
            $('#send_textarea').val('').trigger('input');
        }

        state.running = false;

        // состояние «сводка»
        const okCount = results.filter(r => r.status === 'ok').length;
        const errorCount = results.filter(r => r.status === 'error').length;
        const cancelledCount = results.filter(r => r.status === 'cancelled').length;
        const costs = {};
        for (const r of results) {
            if (r.status === 'ok' && r.cost != null) {
                const key = r.currency ?? '';
                costs[key] = (costs[key] ?? 0) + r.cost;
            }
        }
        const costText = Object.entries(costs)
            .map(([currency, sum]) => formatCost(sum, currency))
            .join(' + ');
        const parts = [`Готово: ${okCount}`];
        if (errorCount) parts.push(`Ошибок: ${errorCount}`);
        if (cancelledCount) parts.push(`Отменено: ${cancelledCount}`);
        if (costText) parts.push(`Потрачено: ${costText}`);
        const errorLines = results.filter(r => r.status === 'error')
            .map(r => `<div class="mcs-error-line">❌ ${escapeHtml(r.charName)} · ${escapeHtml(r.chatFile)}: ${escapeHtml(r.error ?? '')}</div>`)
            .join('');
        $summary.append(`<div class="mcs-summary-line">${parts.join(' · ')}</div>${errorLines}`
            + (restoreError ? `<div class="mcs-error-line">⚠ Не удалось вернуться в исходный чат: ${escapeHtml(restoreError)}</div>` : ''));
        $summary.removeAttr('hidden');
        $stopBtn.attr('hidden', '');
        $closeBtn.removeAttr('hidden');
        $progressWrap.attr('hidden', '');
        if (errorCount || restoreError) {
            toastr.error(`Мульти-отправка завершена с ошибками (${errorCount})`, 'Multi-Chat Send');
        } else {
            toastr.success(`Мульти-отправка завершена: ${okCount} чат(ов)`, 'Multi-Chat Send');
        }
    });

    popup.show().finally(() => {
        if (state.popup === popup) state.popup = null;
    });
}

function formatCost(cost, currency) {
    const value = Number(cost);
    if (!isFinite(value)) return '';
    const sign = currency === 'RUB' ? '₽' : currency === 'USD' ? '$' : (currency ? ` ${currency}` : '');
    return `${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}${sign}`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text ?? '');
    return div.innerHTML;
}

export async function init() {
    loadSettings();
    addWandButton();
    registerSlashCommand();
    try {
        await addSettingsBlock();
    } catch (e) {
        console.error(`[${MODULE_NAME}] settings block failed:`, e);
    }
    log('activated, settings:', getSettings());
}
