PYTHON_PROJECTS := packages/django examples/django
UV := UV_CACHE_DIR=/tmp/uv-cache UV_TOOL_DIR=/tmp/uv-tools UV_STATE_DIR=/tmp/uv-state uv

.PHONY: python-sync python-format-check python-lint python-typecheck python-test python-check

python-sync:
	for dir in $(PYTHON_PROJECTS); do (cd $$dir && $(UV) sync --all-groups); done

python-format-check:
	for dir in $(PYTHON_PROJECTS); do (cd $$dir && $(UV) run ruff format --check .); done

python-lint:
	for dir in $(PYTHON_PROJECTS); do (cd $$dir && $(UV) run ruff check .); done

python-typecheck:
	for dir in $(PYTHON_PROJECTS); do \
		if [ "$$dir" = "examples/django" ]; then \
			(cd $$dir && PYTHONPATH=../../packages/django $(UV) run ty check); \
		else \
			(cd $$dir && $(UV) run ty check); \
		fi; \
	done

python-test:
	for dir in $(PYTHON_PROJECTS); do (cd $$dir && $(UV) run pytest); done

python-check: python-format-check python-lint python-typecheck python-test
