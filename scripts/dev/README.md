# Development scripts

These scripts are internal development and debugging helpers. They may:

- Call external APIs (e.g. OpenAI) and incur costs
- Mutate local test databases (`:memory:` files)
- Require environment variables (API keys, DB paths)

Usage:

1. Review the script before running.
2. Ensure required environment variables are set, e.g. `OPENAI_API_KEY`.
3. Run with Node.js: `node scripts/dev/<script>.mjs`.
4. Do not run these in CI or on production data.

Place safe, minimal examples into `examples/` if you want to provide reproducible, public samples.
