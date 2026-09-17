# Multi-Chat Send (st-multi-chat-send)

SillyTavern UI extension: send one message to several chats at once (sequential broadcast).

For every selected chat the extension opens it, sends the message through the regular
generate pipeline (so world info, instruct templates, prompts and per-message cost
metadata all work as usual), waits for the model reply, then moves to the next chat
and finally returns you to the chat you started in.

## Usage

Two entry points:

- the **Multi-Chat Send** button in the extensions menu (magic-wand drawer next to the
  message input);
- the `/multisend [text]` slash command (opens the same dialog with `text` pre-filled;
  without an argument the current contents of the message input box are used).

In the dialog:

1. edit the message if needed;
2. (un)tick **Генерировать ответы** — with it on, every target chat also gets a model
   reply before the run moves on; with it off, only the user message is appended;
3. filter the list with the search box (character name, chat name, last message text);
4. tick the target chats and press **Отправить**.

During the run the dialog shows per-chat progress and per-chat cost; the **Остановить**
button aborts the current generation and skips the remaining chats. The summary line
shows successes, errors and the total spend per currency.

> Note: while the broadcast is running the chat visibly switches between target chats
> and the dialog cannot be closed. Don't type in the chat until the run finishes.

## Settings

Extensions panel → **Multi-Chat Send**:

| Setting | Default | Meaning |
| --- | --- | --- |
| Возвращаться в исходный чат | on | Reopen the chat you started from when the run ends |
| Генерировать ответы моделей | on | Default for the dialog checkbox |
| Исключать текущий чат | on | Hide the currently open chat from the target list |

## Installation

In SillyTavern: **Extensions → Install extension**, paste:

```
https://github.com/Shamani4/st-multi-chat-send.git
```

or manually:

```
git clone https://github.com/Shamani4/st-multi-chat-send.git \
  public/scripts/extensions/third-party/st-multi-chat-send
```

## Limitations

- Sends are sequential, not parallel (SillyTavern's generation pipeline is bound to a
  single active chat; true parallelism would require core changes).
- Only 1:1 character chats are offered; group chats are not supported yet.
- The extension cannot be used from inside a group chat.
- Concurrent edits of the same chat from another browser tab are not guarded against.

## License

MIT — see [LICENSE](LICENSE).
