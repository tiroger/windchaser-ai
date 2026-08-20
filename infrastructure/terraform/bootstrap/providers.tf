provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Application = "windchaser-ai"
      Environment = "bootstrap"
      ManagedBy   = "terraform"
      Repository  = "windchaser-ai"
    }
  }
}
