terraform {
  # S3 native state locking (use_lockfile) arrived in 1.10 and replaced the
  # DynamoDB lock table. The environment roots depend on it, so the floor here
  # matches theirs.
  required_version = ">= 1.11.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }

  # No backend block. This root creates the bucket every other root stores
  # state in, so its own state cannot live there. It is applied once, by hand,
  # and its state file is committed nowhere.
}
