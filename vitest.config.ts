import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		include: ['src/tests/**/*.test.ts'],
		environment: 'node',
		coverage: {
			provider: 'v8',
			// text for the CI log, lcov for Codecov, html for browsing locally.
			// Without lcov nothing writes coverage/lcov.info, which is the file the Node CI
			// workflow uploads — Codecov then receives an empty report and the build still
			// passes, because the upload is not set to fail the run.
			reporter: ['text', 'lcov', 'html'],
			reportsDirectory: './coverage',
			include: ['src/**/*.ts'],
			exclude: ['src/tests/**'],
		},
	},
})
