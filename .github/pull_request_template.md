<!-- What does this change, and why? -->

### Checks

- [ ] `npm test` passes (it runs on GitHub too)
- [ ] For changes to the controls or the layout: `npm run test:touch` and `npm run test:desktop` pass with a key
- [ ] Tried in Safari, if it touches anything a phone sees

### Needs a close look

Tick any that apply; these are read line by line before merging.

- [ ] Changes where the API key is stored, sent or shown
- [ ] Changes `vite.config.ts` (the security policy), `index.html`, `package.json` or anything in `.github/`
- [ ] Changes the tests themselves
