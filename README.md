# st-multi-chat-send

SillyTavern UI extension: send one message to several chats at once (sequential broadcast).

For every selected chat the extension opens it, sends the message through the regular
generate pipeline (so world info, instruct templates, prompts and per-message cost
metadata all work as usual), waits for the model reply, then moves to the next chat
and finally returns you to the chat you started in.

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

## Status

Work in progress. v0.1.0 — extension skeleton only, no user-facing features yet.

## Limitations

- Sends are sequential, not parallel (SillyTavern's generation pipeline is bound to a
  single active chat; true parallelism would require core changes).
- While the broadcast is running, the UI is busy — do not type or swipe until it finishes.
- Concurrent edits of the same chat from another browser tab are not guarded against.

## License

MIT — see [LICENSE](LICENSE).
