terraform {
  required_version = ">= 1.7"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "SeatSage", Environment = "demo", ManagedBy = "Terraform" }
  }
}

variable "region" { default = "us-east-1" }
variable "vpc_id" { type = string }
variable "public_subnet_ids" {
  type = list(string)
  validation {
    condition     = length(var.public_subnet_ids) >= 2
    error_message = "Provide public subnets in at least two availability zones."
  }
}
variable "private_subnet_ids" {
  type = list(string)
  validation {
    condition     = length(var.private_subnet_ids) >= 2
    error_message = "Provide private subnets in at least two availability zones."
  }
}
variable "allowed_cidrs" {
  description = "Restrict the shared demo to the IP ranges of your reviewers."
  type        = list(string)
}
variable "domain_name" { type = string }
variable "route53_zone_id" { type = string }
variable "certificate_arn" {
  description = "An issued ACM certificate for domain_name in this region."
  type        = string
}
variable "web_image" {
  description = "ECR URI, preferably pinned to a digest."
  type        = string
}
variable "api_image" { type = string }
variable "inventory_image" { type = string }

resource "random_password" "database" {
  length  = 32
  special = false
}
resource "random_password" "session" {
  length  = 48
  special = false
}
resource "random_password" "inventory" {
  length  = 48
  special = false
}
resource "aws_security_group" "load_balancer" {
  name_prefix = "seatsage-alb-"
  vpc_id      = var.vpc_id
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidrs
  }
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidrs
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_security_group" "app" {
  name_prefix = "seatsage-app-"
  vpc_id      = var.vpc_id
  ingress {
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    security_groups = [aws_security_group.load_balancer.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_security_group" "database" {
  name_prefix = "seatsage-db-"
  vpc_id      = var.vpc_id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
}
resource "aws_security_group" "redis" {
  name_prefix = "seatsage-redis-"
  vpc_id      = var.vpc_id
  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
}
resource "aws_db_subnet_group" "demo" {
  name_prefix = "seatsage-"
  subnet_ids  = var.private_subnet_ids
}
resource "aws_db_instance" "demo" {
  identifier_prefix       = "seatsage-demo-"
  engine                  = "postgres"
  engine_version          = "16"
  instance_class          = "db.t4g.micro"
  allocated_storage       = 20
  storage_encrypted       = true
  db_name                 = "seatsage"
  username                = "seatsage"
  password                = random_password.database.result
  db_subnet_group_name    = aws_db_subnet_group.demo.name
  vpc_security_group_ids  = [aws_security_group.database.id]
  publicly_accessible     = false
  backup_retention_period = 1
  skip_final_snapshot     = true
  deletion_protection     = false
}
resource "aws_elasticache_subnet_group" "demo" {
  name       = "seatsage-demo"
  subnet_ids = var.private_subnet_ids
}
resource "aws_elasticache_replication_group" "demo" {
  replication_group_id       = "seatsage-demo"
  description                = "SeatSage demo hold cache"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = "cache.t4g.micro"
  num_cache_clusters         = 1
  automatic_failover_enabled = false
  port                       = 6379
  subnet_group_name          = aws_elasticache_subnet_group.demo.name
  security_group_ids         = [aws_security_group.redis.id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
}
resource "aws_secretsmanager_secret" "app" { name_prefix = "seatsage-demo-" }
resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    database_url    = "postgres://seatsage:${random_password.database.result}@${aws_db_instance.demo.endpoint}/seatsage?sslmode=require"
    session_secret  = random_password.session.result
    inventory_token = random_password.inventory.result
  })
}
resource "aws_iam_role" "execution" {
  name_prefix = "seatsage-execution-"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole"
    }]
  })
}
resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
resource "aws_iam_role_policy" "secrets" {
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = aws_secretsmanager_secret.app.arn
    }]
  })
}
resource "aws_cloudwatch_log_group" "app" {
  name              = "/seatsage/demo"
  retention_in_days = 7
}
resource "aws_ecs_cluster" "demo" { name = "seatsage-demo" }
resource "aws_lb" "demo" {
  name_prefix        = "sage-"
  load_balancer_type = "application"
  subnets            = var.public_subnet_ids
  security_groups    = [aws_security_group.load_balancer.id]
}
resource "aws_lb_target_group" "web" {
  name_prefix = "sage-"
  port        = 80
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  health_check {
    path                = "/api/v1/health"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.demo.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}
resource "aws_lb_listener" "redirect" {
  load_balancer_arn = aws_lb.demo.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}
resource "aws_route53_record" "demo" {
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"
  alias {
    name                   = aws_lb.demo.dns_name
    zone_id                = aws_lb.demo.zone_id
    evaluate_target_health = true
  }
}

locals {
  logs = {
    logDriver = "awslogs"
    options = {
      awslogs-group = aws_cloudwatch_log_group.app.name, awslogs-region = var.region, awslogs-stream-prefix = "demo"
    }
  }
  database_secret  = { name = "DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.app.arn}:database_url::" }
  inventory_secret = { name = "INVENTORY_TOKEN", valueFrom = "${aws_secretsmanager_secret.app.arn}:inventory_token::" }
}
resource "aws_ecs_task_definition" "demo" {
  family                   = "seatsage-demo"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "2048"
  memory                   = "4096"
  execution_role_arn       = aws_iam_role.execution.arn
  container_definitions = jsonencode([
    {
      name   = "elasticsearch", image = "docker.elastic.co/elasticsearch/elasticsearch:8.17.3", essential = true,
      memory = 1536, logConfiguration = local.logs,
      environment = [
        { name = "discovery.type", value = "single-node" },
        { name = "xpack.security.enabled", value = "false" },
        { name = "node.store.allow_mmap", value = "false" },
        { name = "ES_JAVA_OPTS", value = "-Xms512m -Xmx512m" }
      ],
      healthCheck = {
        command  = ["CMD-SHELL", "curl -fsS http://localhost:9200/_cluster/health || exit 1"],
        interval = 15, timeout = 5, retries = 10, startPeriod = 120
      }
    },
    {
      name             = "inventory", image = var.inventory_image, essential = true, memory = 512,
      logConfiguration = local.logs,
      secrets          = [local.database_secret, local.inventory_secret],
      environment = [
        { name = "REDIS_URL", value = "rediss://${aws_elasticache_replication_group.demo.primary_endpoint_address}:6379/0" },
        { name = "HOLD_TTL_SECONDS", value = "300" }
      ],
      healthCheck = {
        command  = ["CMD-SHELL", "wget -q -O - http://localhost:8081/health || exit 1"],
        interval = 10, timeout = 5, retries = 5, startPeriod = 15
      }
    },
    {
      name             = "api", image = var.api_image, essential = true, memory = 1024,
      logConfiguration = local.logs,
      dependsOn = [
        { containerName = "elasticsearch", condition = "HEALTHY" },
        { containerName = "inventory", condition = "HEALTHY" }
      ],
      secrets = [
        local.database_secret, local.inventory_secret,
        { name = "SESSION_SECRET", valueFrom = "${aws_secretsmanager_secret.app.arn}:session_secret::" }
      ],
      environment = [
        { name = "APP_MODE", value = "distributed" },
        { name = "INVENTORY_URL", value = "http://localhost:8081" },
        { name = "ELASTICSEARCH_URL", value = "http://localhost:9200" },
        { name = "ALLOWED_ORIGINS", value = "https://${var.domain_name}" },
        { name = "COOKIE_SECURE", value = "true" }
      ],
      healthCheck = {
        command  = ["CMD-SHELL", "python -c \"import urllib.request; urllib.request.urlopen('http://localhost:8000/api/v1/health')\""],
        interval = 10, timeout = 5, retries = 5, startPeriod = 30
      }
    },
    {
      name             = "web", image = var.web_image, essential = true, memory = 256,
      logConfiguration = local.logs,
      environment      = [{ name = "API_UPSTREAM", value = "localhost:8000" }],
      dependsOn        = [{ containerName = "api", condition = "HEALTHY" }],
      portMappings     = [{ containerPort = 80, protocol = "tcp" }]
    }
  ])
}
resource "aws_ecs_service" "demo" {
  name                               = "seatsage-demo"
  cluster                            = aws_ecs_cluster.demo.id
  task_definition                    = aws_ecs_task_definition.demo.arn
  desired_count                      = 1
  launch_type                        = "FARGATE"
  health_check_grace_period_seconds  = 240
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  network_configuration {
    subnets          = var.public_subnet_ids
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = true
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 80
  }
  depends_on = [
    aws_lb_listener.https, aws_iam_role_policy_attachment.execution,
    aws_iam_role_policy.secrets, aws_secretsmanager_secret_version.app
  ]
}
output "demo_url" { value = "https://${var.domain_name}" }
