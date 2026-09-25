# Knowledge base

What JVA has learned, exported from a Mac by `npm run kb:export`.

When Jev has no command for a request, JVA asks a language model (GPT-6 Luna on
OpenRouter by default) to design one out of its own building blocks, checks it,
and keeps it once the user has tried it and said yes. Every lesson is recorded:

- `learned-commands.json` — the commands learned, as they are kept on the Mac
- `knowledge-base.jsonl` — every lesson, learned or forgotten, one per line

This is the record that future built-in commands are made from: a command
learned by many people, or used often, is a candidate for the registry
(`src/main/actions/registry.ts`), where it can be written properly and tested.

Each entry includes the request that taught it, in the user's own words. Read
it through before committing.
