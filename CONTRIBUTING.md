# Contributing to ClawMem

Thanks for your interest in contributing. This guide covers everything you need to get started.

## Prerequisites

- [Bun](https://bun.sh/) >= 1.0.0
- [llama-server](https://github.com/ggerganov/llama.cpp) (optional — all three models auto-download via `node-llama-cpp`, using Metal on Apple Silicon, Vulkan where available, or CPU as last resort)
- A dedicated GPU with 4-12 GB VRAM for best performance (optional — fast with integrated GPU acceleration via Metal/Vulkan, significantly slower on CPU-only)

## Development Setup

```bash
# Clone and install
git clone https://github.com/yoloshii/ClawMem.git
cd ClawMem
bun install

# Optional: start GPU inference services for performance (see CLAUDE.md for model details)
# Without these, all three models auto-download via node-llama-cpp
# (Metal on Apple Silicon, Vulkan where available, CPU as last resort)
llama-server -m embeddinggemma-300M-Q8_0.gguf --embeddings --port 8088 -ngl 99 -c 2048 --batch-size 2048
llama-server -m qmd-query-expansion-1.7B-q4_k_m.gguf --port 8089 -ngl 99 -c 4096
llama-server -m Qwen3-Reranker-0.6B-Q8_0.gguf --reranking --port 8090 -ngl 99 -c 2048 --batch-size 512
```

## Running Tests

```bash
# All tests
bun test

# Specific test file
bun test tests/unit/some-file.test.ts
```

## Project Structure

```
src/           # Source code (TypeScript)
bin/           # CLI wrapper
tests/
  unit/        # Unit tests (no GPU needed)
  fixtures/    # Test data
  helpers/     # Shared test utilities
config.yaml    # Default configuration
```

## Making Changes

1. **Fork and branch** -- create a feature branch from `main`:
   ```bash
   git checkout -b feature/your-change
   ```

2. **Write tests first** -- add or update tests in `tests/` for your change. Tests should assert correct behavior, not current behavior.

3. **Make your changes** -- keep commits focused. One logical change per commit.

4. **Run the full test suite** before submitting:
   ```bash
   bun test
   ```

5. **Use the CLI wrapper** for manual testing -- always use `bin/clawmem`, never `bun run src/clawmem.ts` directly.

## Pull Request Guidelines

- **One concern per PR.** Bug fix, feature, or refactor -- pick one.
- **Describe what and why** in the PR description. Link related issues.
- **Keep diffs small.** Large PRs are hard to review and slow to merge. If your change is big, break it into stacked PRs.
- **No unrelated formatting changes.** Don't reformat files you didn't meaningfully change.
- **Tests must pass.** PRs with failing tests won't be merged.

## Code Style

- TypeScript strict mode. No `any` unless absolutely necessary (and commented why).
- Use `bun:sqlite` for database operations -- no external SQLite bindings.
- Error handling: fail fast and loud. No silent swallowing of errors.
- Prefer early returns over deep nesting.

## Reporting Bugs

Use the [bug report template](https://github.com/yoloshii/ClawMem/issues/new?template=bug-report.yml). Include:
- Steps to reproduce
- Expected vs actual behavior
- Your environment (OS, Bun version, GPU)

## Requesting Features

Use the [feature request template](https://github.com/yoloshii/ClawMem/issues/new?template=feature-request.yml). Describe the problem you're solving, not just the solution you want.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
