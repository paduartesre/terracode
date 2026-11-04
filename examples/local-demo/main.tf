terraform {
  required_version = ">= 1.4.0"
}

resource "terraform_data" "demo" {
  input = "TerraCode local demo"
}

output "demo_message" {
  value = terraform_data.demo.output
}
