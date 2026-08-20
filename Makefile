.PHONY: help uv-sync uv-lock terraform-fmt terraform-validate

help:
	@echo "WindChaser AI development commands"
	@echo "  uv-sync             Install pinned Python and locked dependencies"
	@echo "  uv-lock             Refresh the Python dependency lock file"
	@echo "  terraform-fmt       Format Terraform files"
	@echo "  terraform-validate  Validate dev and prod Terraform roots"

uv-sync:
	uv python install
	uv sync --locked --all-groups

uv-lock:
	uv lock

terraform-fmt:
	terraform fmt -recursive infrastructure/terraform

terraform-validate:
	terraform -chdir=infrastructure/terraform/environments/dev init -backend=false
	terraform -chdir=infrastructure/terraform/environments/dev validate
	terraform -chdir=infrastructure/terraform/environments/prod init -backend=false
	terraform -chdir=infrastructure/terraform/environments/prod validate
