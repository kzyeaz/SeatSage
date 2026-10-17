# AWS demo deployment

`main.tf` is an optional Terraform deployment for a **restricted demo**, not a production availability reference. Nothing in the normal local startup runs Terraform.

## What it provisions

- An HTTPS application load balancer and Route 53 alias.
- One ECS Fargate task containing Nginx/React, FastAPI, Go inventory, and single-node Elasticsearch.
- Private RDS PostgreSQL and ElastiCache Redis (TLS enabled).
- Security groups, Secrets Manager values, a task execution role, and CloudWatch logs.

The task runs in a public subnet to pull images without provisioning a NAT gateway. Its inbound access is limited to port 80 from the load balancer security group. PostgreSQL and Redis accept traffic only from the task security group. Elasticsearch and inventory are reachable only inside the task network.

The application containers share `localhost` in the Fargate task. This is a practical demo compromise. The proposed scalable topology separates API and Go into independent ECS services, serves static assets through S3/CloudFront, and uses durable managed search. See `docs/architecture.md`.

## Prerequisites

You need an AWS account, Terraform 1.7+, AWS CLI credentials, and:

1. An existing VPC with DNS support, at least two public subnets with internet-gateway routes, and two private subnets, spanning two availability zones.
2. A Route 53 zone and an issued ACM certificate for the demo hostname in the same region.
3. Three ECR repositories and pushed Linux AMD64 images, built from the root:

```sh
docker build --platform linux/amd64 -f web/Dockerfile -t YOUR_WEB_ECR_URI:demo .
docker build --platform linux/amd64 -f api/Dockerfile -t YOUR_API_ECR_URI:demo .
docker build --platform linux/amd64 -f services/inventory/Dockerfile -t YOUR_INVENTORY_ECR_URI:demo .
```

Authenticate to your ECR registry with the AWS CLI, then push those tags. Prefer immutable image digests for repeatable deployments.

Copy `terraform.tfvars.example` to `terraform.tfvars` and fill in resource IDs, image URIs, hostname, and your reviewers’ public IP CIDRs.

```sh
terraform init
terraform fmt -check
terraform validate
terraform plan -out=demo.tfplan
# Review the concrete resources and costs before deployment.
terraform apply demo.tfplan
```

Open the `demo_url` output. Initial RDS provisioning and Elasticsearch startup take several minutes.

## Operational limits

- **This creates billable resources**: ALB, Fargate, RDS, Redis, storage, logs, and DNS queries. It is not a free-tier guarantee.
- Demo role switching remains enabled. Restrict `allowed_cidrs` to reviewers.
- There is one task, one Redis node, and one RDS instance. Replacements cause downtime. Deployments intentionally stop the old demo task before starting the new one.
- Elasticsearch uses ephemeral task storage and is rebuilt from PostgreSQL at startup. It is not a durable search cluster.
- Terraform state contains generated secret values. Keep it out of Git and use an encrypted, access-controlled state backend for shared work.
- The database uses `sslmode=require`; a production deployment should install the RDS CA bundle and use `verify-full`.
- The HTTP-to-HTTPS redirect does not expose the database or inventory service.
- The supplied demo uses `skip_final_snapshot=true` and disables deletion protection to allow clean teardown. Export anything you want to retain before teardown.

When finished with a deployment, review `terraform plan -destroy`, then run `terraform destroy` to remove these resources. Existing VPCs, subnets, ACM certificates, and ECR repositories are inputs and are not deleted by this module.

No AWS performance or availability claim should be inferred from the existence of this configuration.
