# Contributing to IngestLab

## Before you start

Search existing issues and pull requests before opening a new one. For larger
changes, open an issue first so the scope and acceptance criteria are clear.

Keep changes focused. Avoid unrelated formatting, generated fixture churn, or
API changes without documentation and tests.

## Development

Use Node.js 18 or newer and install dependencies with npm.

```sh
npm install
npm test
npm run types:check
npm run build
```

Run focused checks that match your change. PDF changes should include a small
fixture or regression test when possible. Changes to OCR, tables, forms,
figures, RAG, or video should document the input and expected output.

The default PDF.js peer is `~4.8.69`. Keep worker, font, CMap, and WASM assets
on the same PDF.js version when testing browser integrations.

## Pull requests

Pull requests should explain the user-visible behavior, list the tests run,
and call out compatibility or performance changes. Include benchmark results
when the change affects parsing quality, latency, memory, or bundle size.

Keep commit messages short and specific. Do not include secrets, private
documents, or large generated PDFs unless they are required test fixtures.

By contributing, you agree that your contribution is provided under the
project's MIT license.
