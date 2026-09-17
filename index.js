import { getContext } from '../../../extensions.js';

const MODULE_NAME = 'st-multi-chat-send';

const log = (...args) => console.log(`[${MODULE_NAME}]`, ...args);

export async function init() {
    const context = getContext();
    log('activated, SillyTavern context available:', Boolean(context));
}
