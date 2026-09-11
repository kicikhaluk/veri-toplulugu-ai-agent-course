# Research Notes

Questions to answer:
- What testing framework does the anthropics/anthropic-sdk-typescript repository use?

## Findings

The anthropics/anthropic-sdk-typescript repository uses **Jest** as its testing framework.

### Key Details:
- **Primary Framework**: Jest is invoked via the `test` script defined in `package.json` files
- **TypeScript Support**: Uses `ts-jest` preset (`ts-jest/presets/default-esm`) to allow Jest to run TypeScript tests
- **Compiler**: Uses `@swc/jest` for transforming TypeScript and JavaScript files, providing faster compilation than default TypeScript compilation
- **Test Environment**: Configured to run in Node.js environment (`testEnvironment: 'node'`)
- **Test Organization**: Tests use Jest's standard `describe`, `test`, `expect`, `beforeEach`, and `afterEach` functions
- **Monorepo Testing**: The `scripts/test` script orchestrates testing across the main package and sub-packages (vertex-sdk, bedrock-sdk, foundry-sdk)
- **Running Tests**: Tests can be run using `yarn run test` command
- **Mock Infrastructure**: Uses a mock server setup via `scripts/mock` for API interaction testing
