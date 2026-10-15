# AWS Setup Procedure

This document provisions all AWS infrastructure required to run Arbor. Setup is split into two parts:

- **Part 1 — Shared resources** (run once per AWS account): OIDC provider, ECR repository, S3 artifact bucket.
- **Part 2 — Per-environment resources** (run once with `ENV=dev`, then again with `ENV=prod`): VPC, database, secrets, SQS, IAM roles, ECS cluster/service, Lambda, API Gateway.

## Prerequisites

- AWS CLI v2 configured with IAM credentials that have admin (or equivalently scoped) permissions
- Docker installed locally
- Arbor repository cloned and `npm install` run
- Your GitHub repository name (e.g. `your-org/arbor`) — used to scope the OIDC trust policy

## How to use this document

1. Copy each script below into a file (e.g. `setup-shared.sh`, `setup-env.sh`)
2. Fill in the **Configuration** block at the top of each script
3. Run shared setup once: `bash setup-shared.sh`
4. Run environment setup for dev: `ENV=dev bash setup-env.sh`
5. Run environment setup for prod: `ENV=prod bash setup-env.sh`

Scripts are safe to run section by section in a terminal — variable names are consistent throughout.

---

## Part 1: Shared Resources

Run once per AWS account, before any environment setup.

```bash
#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Configuration — fill these in before running
# =============================================================================

AWS_REGION="us-east-1"
GITHUB_REPO="your-org/arbor"          # used to scope OIDC trust to this repo only
ARTIFACT_BUCKET="arbor-lambda-artifacts"  # must be globally unique

# =============================================================================
# Derived
# =============================================================================

export AWS_REGION
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "Account: $AWS_ACCOUNT_ID  Region: $AWS_REGION"


# =============================================================================
# 1. GitHub Actions OIDC provider
# =============================================================================
# Allows GitHub Actions workflows to assume IAM roles via short-lived tokens
# instead of long-lived access keys.

echo "--- 1. OIDC provider ---"

aws iam create-openid-connect-provider \
  --url "https://token.actions.githubusercontent.com" \
  --client-id-list "sts.amazonaws.com" \
  --thumbprint-list "6938fd4d98bab03faadb97b34396831e3780aea1"

echo "OIDC provider created."


# =============================================================================
# 2. ECR repository (shared between dev and prod)
# =============================================================================
# Both environments pull from the same repository; images are distinguished
# by tag (git SHA, dev, prod).

echo "--- 2. ECR ---"

aws ecr create-repository \
  --repository-name arbor-agent \
  --image-scanning-configuration scanOnPush=true \
  --image-tag-mutability MUTABLE

echo "ECR repository created."


# =============================================================================
# 3. S3 artifact bucket for Lambda zips
# =============================================================================
# The CI pipeline uploads a Lambda zip keyed by git SHA on every dev deploy.
# Promotion downloads the same zip to deploy to prod, guaranteeing the artifact
# is identical between environments.

echo "--- 3. S3 artifact bucket ---"

if [ "$AWS_REGION" = "us-east-1" ]; then
  aws s3api create-bucket --bucket "$ARTIFACT_BUCKET"
else
  aws s3api create-bucket --bucket "$ARTIFACT_BUCKET" \
    --create-bucket-configuration LocationConstraint="$AWS_REGION"
fi

aws s3api put-bucket-versioning \
  --bucket "$ARTIFACT_BUCKET" \
  --versioning-configuration Status=Enabled

aws s3api put-public-access-block \
  --bucket "$ARTIFACT_BUCKET" \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,\
BlockPublicPolicy=true,RestrictPublicBuckets=true

echo "Artifact bucket: $ARTIFACT_BUCKET"


# =============================================================================
# 4. GitHub Actions deploy roles (one per environment)
# =============================================================================
# Each role is assumed by GitHub Actions via OIDC. Permissions are scoped to
# what the corresponding CI workflow actually needs.

echo "--- 4. Deploy IAM roles ---"

OIDC_PROVIDER="arn:aws:iam::${AWS_ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"

TRUST_POLICY=$(cat <<TRUST
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "${OIDC_PROVIDER}" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringLike": {
        "token.actions.githubusercontent.com:sub": "repo:${GITHUB_REPO}:*"
      },
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
      }
    }
  }]
}
TRUST
)

# Dev deploy role — used by deploy-dev.yml (triggered on every merge to main)
aws iam create-role \
  --role-name arbor-deploy-dev \
  --assume-role-policy-document "$TRUST_POLICY"

aws iam put-role-policy \
  --role-name arbor-deploy-dev \
  --policy-name arbor-deploy-dev-policy \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Sid\": \"ECR\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"ecr:GetAuthorizationToken\",
          \"ecr:BatchCheckLayerAvailability\",
          \"ecr:BatchGetImage\",
          \"ecr:GetDownloadUrlForLayer\",
          \"ecr:InitiateLayerUpload\",
          \"ecr:UploadLayerPart\",
          \"ecr:CompleteLayerUpload\",
          \"ecr:PutImage\",
          \"ecr:DescribeImages\"
        ],
        \"Resource\": \"*\"
      },
      {
        \"Sid\": \"S3Artifact\",
        \"Effect\": \"Allow\",
        \"Action\": [\"s3:PutObject\", \"s3:GetObject\"],
        \"Resource\": \"arn:aws:s3:::${ARTIFACT_BUCKET}/arbor-webhook/*\"
      },
      {
        \"Sid\": \"SSMDigest\",
        \"Effect\": \"Allow\",
        \"Action\": \"ssm:PutParameter\",
        \"Resource\": \"arn:aws:ssm:${AWS_REGION}:${AWS_ACCOUNT_ID}:parameter/arbor/artifacts/*/sha256\"
      },
      {
        \"Sid\": \"Lambda\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"lambda:UpdateFunctionCode\",
          \"lambda:GetFunctionConfiguration\"
        ],
        \"Resource\": \"arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:function:arbor-webhook-dev\"
      },
      {
        \"Sid\": \"ECS\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"ecs:DescribeTaskDefinition\",
          \"ecs:RegisterTaskDefinition\",
          \"ecs:UpdateService\",
          \"ecs:DescribeServices\"
        ],
        \"Resource\": \"*\"
      },
      {
        \"Sid\": \"PassRole\",
        \"Effect\": \"Allow\",
        \"Action\": \"iam:PassRole\",
        \"Resource\": [
          \"arn:aws:iam::${AWS_ACCOUNT_ID}:role/arbor-ecs-execution-role-dev\",
          \"arn:aws:iam::${AWS_ACCOUNT_ID}:role/arbor-ecs-task-role-dev\"
        ]
      }
    ]
  }"

# Prod deploy role — used by promote-prod.yml (manual workflow_dispatch)
aws iam create-role \
  --role-name arbor-deploy-prod \
  --assume-role-policy-document "$TRUST_POLICY"

aws iam put-role-policy \
  --role-name arbor-deploy-prod \
  --policy-name arbor-deploy-prod-policy \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Sid\": \"ECR\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"ecr:GetAuthorizationToken\",
          \"ecr:BatchGetImage\",
          \"ecr:GetDownloadUrlForLayer\",
          \"ecr:PutImage\",
          \"ecr:DescribeImages\"
        ],
        \"Resource\": \"*\"
      },
      {
        \"Sid\": \"S3Artifact\",
        \"Effect\": \"Allow\",
        \"Action\": \"s3:GetObject\",
        \"Resource\": \"arn:aws:s3:::${ARTIFACT_BUCKET}/arbor-webhook/*\"
      },
      {
        \"Sid\": \"SSMDigest\",
        \"Effect\": \"Allow\",
        \"Action\": \"ssm:GetParameter\",
        \"Resource\": \"arn:aws:ssm:${AWS_REGION}:${AWS_ACCOUNT_ID}:parameter/arbor/artifacts/*/sha256\"
      },
      {
        \"Sid\": \"Lambda\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"lambda:UpdateFunctionCode\",
          \"lambda:GetFunctionConfiguration\"
        ],
        \"Resource\": \"arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:function:arbor-webhook-prod\"
      },
      {
        \"Sid\": \"ECS\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"ecs:DescribeTaskDefinition\",
          \"ecs:RegisterTaskDefinition\",
          \"ecs:UpdateService\",
          \"ecs:DescribeServices\"
        ],
        \"Resource\": \"*\"
      },
      {
        \"Sid\": \"PassRole\",
        \"Effect\": \"Allow\",
        \"Action\": \"iam:PassRole\",
        \"Resource\": [
          \"arn:aws:iam::${AWS_ACCOUNT_ID}:role/arbor-ecs-execution-role-prod\",
          \"arn:aws:iam::${AWS_ACCOUNT_ID}:role/arbor-ecs-task-role-prod\"
        ]
      }
    ]
  }"

echo "Deploy roles created."
echo ""
echo "============================================================"
echo "Shared setup complete."
echo ""
echo "Record these values as GitHub Actions secrets:"
echo "  AWS_ACCOUNT_ID        = $AWS_ACCOUNT_ID"
echo "  AWS_REGION            = $AWS_REGION"
echo "  LAMBDA_ARTIFACT_BUCKET = $ARTIFACT_BUCKET"
echo "  AWS_ROLE_DEV          = arn:aws:iam::${AWS_ACCOUNT_ID}:role/arbor-deploy-dev"
echo "  AWS_ROLE_PROD         = arn:aws:iam::${AWS_ACCOUNT_ID}:role/arbor-deploy-prod"
echo "============================================================"
```

---

## Part 2: Per-Environment Resources

Run with `ENV=dev`, then again with `ENV=prod`. All resource names are suffixed with the environment name.

```bash
#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Configuration — fill these in before running
# Secrets differ between environments; fill in the correct values for each run.
# =============================================================================

: "${ENV:?ENV must be set to 'dev' or 'prod'}"
if [[ "$ENV" != "dev" && "$ENV" != "prod" ]]; then
  echo "ENV must be 'dev' or 'prod'"; exit 1
fi

AWS_REGION="us-east-1"
ARTIFACT_BUCKET="arbor-lambda-artifacts"   # must match Part 1
DB_PASSWORD="change-me-use-something-strong"
SLACK_SIGNING_SECRET="your-slack-signing-secret"
SLACK_BOT_TOKEN="xoxb-your-bot-token"
ANTHROPIC_API_KEY="sk-ant-your-key"
GOOGLE_CREDENTIALS_FILE="/path/to/service-account.json"
GITHUB_TOKEN="ghp_your-token"
ADMIN_USER_IDS="U12345678"   # comma-separated Slack user IDs for /squirrel-admin

# Set USE_EXISTING_DB=true to skip RDS creation and use an existing PostgreSQL
# instance. Required if your DB is not reachable from this machine (see §2).
USE_EXISTING_DB="false"
EXISTING_DB_HOST=""
EXISTING_DB_NAME="arbor"
EXISTING_DB_USER="arbor"
EXISTING_DB_PASSWORD=""

# =============================================================================
# Derived
# =============================================================================

export AWS_REGION
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
E="$ENV"   # short alias used in resource names throughout
echo "Account: $AWS_ACCOUNT_ID  Region: $AWS_REGION  Environment: $E"


# =============================================================================
# 1. Networking
# =============================================================================

echo "--- 1. Networking ---"

VPC_ID=$(aws ec2 create-vpc \
  --cidr-block 10.0.0.0/16 \
  --tag-specifications "ResourceType=vpc,Tags=[{Key=Name,Value=arbor-${E}}]" \
  --query Vpc.VpcId --output text)

aws ec2 modify-vpc-attribute --vpc-id "$VPC_ID" --enable-dns-hostnames
aws ec2 modify-vpc-attribute --vpc-id "$VPC_ID" --enable-dns-support

PRIVATE_SUBNET_A=$(aws ec2 create-subnet \
  --vpc-id "$VPC_ID" --cidr-block 10.0.1.0/24 \
  --availability-zone "${AWS_REGION}a" \
  --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=arbor-${E}-private-a}]" \
  --query Subnet.SubnetId --output text)

PRIVATE_SUBNET_B=$(aws ec2 create-subnet \
  --vpc-id "$VPC_ID" --cidr-block 10.0.2.0/24 \
  --availability-zone "${AWS_REGION}b" \
  --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=arbor-${E}-private-b}]" \
  --query Subnet.SubnetId --output text)

PUBLIC_SUBNET=$(aws ec2 create-subnet \
  --vpc-id "$VPC_ID" --cidr-block 10.0.0.0/24 \
  --availability-zone "${AWS_REGION}a" \
  --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=arbor-${E}-public}]" \
  --query Subnet.SubnetId --output text)

IGW_ID=$(aws ec2 create-internet-gateway \
  --tag-specifications "ResourceType=internet-gateway,Tags=[{Key=Name,Value=arbor-${E}-igw}]" \
  --query InternetGateway.InternetGatewayId --output text)
aws ec2 attach-internet-gateway --internet-gateway-id "$IGW_ID" --vpc-id "$VPC_ID"

EIP_ALLOC=$(aws ec2 allocate-address --domain vpc --query AllocationId --output text)

NAT_GW_ID=$(aws ec2 create-nat-gateway \
  --subnet-id "$PUBLIC_SUBNET" \
  --allocation-id "$EIP_ALLOC" \
  --tag-specifications "ResourceType=natgateway,Tags=[{Key=Name,Value=arbor-${E}-nat}]" \
  --query NatGateway.NatGatewayId --output text)

echo "Waiting for NAT gateway..."
aws ec2 wait nat-gateway-available --nat-gateway-ids "$NAT_GW_ID"

PUBLIC_RT=$(aws ec2 create-route-table --vpc-id "$VPC_ID" \
  --query RouteTable.RouteTableId --output text)
aws ec2 create-route --route-table-id "$PUBLIC_RT" \
  --destination-cidr-block 0.0.0.0/0 --gateway-id "$IGW_ID"
aws ec2 associate-route-table --route-table-id "$PUBLIC_RT" --subnet-id "$PUBLIC_SUBNET"

PRIVATE_RT=$(aws ec2 create-route-table --vpc-id "$VPC_ID" \
  --query RouteTable.RouteTableId --output text)
aws ec2 create-route --route-table-id "$PRIVATE_RT" \
  --destination-cidr-block 0.0.0.0/0 --nat-gateway-id "$NAT_GW_ID"
aws ec2 associate-route-table --route-table-id "$PRIVATE_RT" --subnet-id "$PRIVATE_SUBNET_A"
aws ec2 associate-route-table --route-table-id "$PRIVATE_RT" --subnet-id "$PRIVATE_SUBNET_B"

RDS_SG=$(aws ec2 create-security-group \
  --group-name "arbor-${E}-rds" --description "Arbor ${E} RDS" --vpc-id "$VPC_ID" \
  --query GroupId --output text)

APP_SG=$(aws ec2 create-security-group \
  --group-name "arbor-${E}-app" --description "Arbor ${E} Lambda and ECS" --vpc-id "$VPC_ID" \
  --query GroupId --output text)

aws ec2 authorize-security-group-ingress \
  --group-id "$RDS_SG" --protocol tcp --port 5432 --source-group "$APP_SG"

# VPC endpoints — keep AWS API traffic off the NAT gateway
ENDPOINT_SG=$(aws ec2 create-security-group \
  --group-name "arbor-${E}-endpoints" \
  --description "Arbor ${E} VPC interface endpoints" \
  --vpc-id "$VPC_ID" \
  --query GroupId --output text)

aws ec2 authorize-security-group-ingress \
  --group-id "$ENDPOINT_SG" --protocol tcp --port 443 --source-group "$APP_SG"

# S3 gateway endpoint (free; ECR stores image layers in S3)
aws ec2 create-vpc-endpoint \
  --vpc-id "$VPC_ID" \
  --service-name "com.amazonaws.${AWS_REGION}.s3" \
  --vpc-endpoint-type Gateway \
  --route-table-ids "$PRIVATE_RT"

for SVC in ecr.api ecr.dkr sqs secretsmanager logs ssm; do
  aws ec2 create-vpc-endpoint \
    --vpc-id "$VPC_ID" \
    --service-name "com.amazonaws.${AWS_REGION}.${SVC}" \
    --vpc-endpoint-type Interface \
    --subnet-ids "$PRIVATE_SUBNET_A" "$PRIVATE_SUBNET_B" \
    --security-group-ids "$ENDPOINT_SG" \
    --private-dns-enabled
done

echo "Networking done. VPC=$VPC_ID"


# =============================================================================
# 2. Database (RDS PostgreSQL or existing)
# =============================================================================
# NOTE: RDS is provisioned in a private subnet. The CI pipeline runs migrations
# from a GitHub Actions runner, which is not inside the VPC. If you create a
# private RDS instance, migrations will fail unless you either:
#   a) Use USE_EXISTING_DB=true with an externally reachable database (e.g.
#      Neon, Railway, Supabase, or an RDS instance with a public endpoint), or
#   b) Use a self-hosted GitHub Actions runner inside the VPC, or
#   c) Run migrations manually from a bastion host before the first deploy.
#
# Recommendation for simplicity: use an external managed database with a public
# connection string for DATABASE_URL_DEV / DATABASE_URL_PROD, and set
# USE_EXISTING_DB=true.

echo "--- 2. Database ---"

if [ "$USE_EXISTING_DB" = "true" ]; then
  DATABASE_URL="postgres://${EXISTING_DB_USER}:${EXISTING_DB_PASSWORD}@${EXISTING_DB_HOST}/${EXISTING_DB_NAME}?sslmode=require"
  echo "Using existing database. Host=${EXISTING_DB_HOST}"
else
  aws rds create-db-subnet-group \
    --db-subnet-group-name "arbor-${E}-db-subnets" \
    --db-subnet-group-description "Arbor ${E} DB subnets" \
    --subnet-ids "$PRIVATE_SUBNET_A" "$PRIVATE_SUBNET_B"

  aws rds create-db-instance \
    --db-instance-identifier "arbor-${E}" \
    --db-instance-class db.t4g.micro \
    --engine postgres \
    --engine-version 16 \
    --master-username arbor \
    --master-user-password "$DB_PASSWORD" \
    --db-name arbor \
    --allocated-storage 20 \
    --storage-type gp3 \
    --no-publicly-accessible \
    --vpc-security-group-ids "$RDS_SG" \
    --db-subnet-group-name "arbor-${E}-db-subnets" \
    --backup-retention-period 7 \
    --no-multi-az

  echo "Waiting for RDS instance (5-10 min)..."
  aws rds wait db-instance-available --db-instance-identifier "arbor-${E}"

  DB_HOST=$(aws rds describe-db-instances \
    --db-instance-identifier "arbor-${E}" \
    --query 'DBInstances[0].Endpoint.Address' --output text)

  DATABASE_URL="postgres://arbor:${DB_PASSWORD}@${DB_HOST}/arbor?sslmode=require"
  echo "Database ready. Host=$DB_HOST"
fi

# Migrations must be run before the first deploy. If the database is reachable
# from this machine, uncomment the next line:
# (cd packages/db && DATABASE_URL="$DATABASE_URL" npm run db:migrate)
#
# Otherwise, apply manually. The current schema (packages/db/drizzle/):
#
#   CREATE TABLE IF NOT EXISTS url_config (
#     url         TEXT PRIMARY KEY,
#     description TEXT        NOT NULL,
#     enabled     BOOLEAN     NOT NULL DEFAULT true,
#     added_by    TEXT        NOT NULL,
#     added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
#   );
#
#   CREATE TABLE IF NOT EXISTS agent_config (
#     key   TEXT PRIMARY KEY,
#     value TEXT NOT NULL
#   );
#
#   CREATE TABLE IF NOT EXISTS audit_log (
#     id          SERIAL PRIMARY KEY,
#     channel     TEXT        NOT NULL,
#     thread_ts   TEXT        NOT NULL,
#     user_id     TEXT        NOT NULL,
#     prompt      TEXT        NOT NULL,
#     response    TEXT        NOT NULL,
#     model       TEXT,
#     duration_ms INTEGER     NOT NULL,
#     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
#   );


# =============================================================================
# 3. Secrets Manager
# =============================================================================

echo "--- 3. Secrets ---"

aws secretsmanager create-secret \
  --name "arbor-${E}/database-url" \
  --secret-string "$DATABASE_URL"

aws secretsmanager create-secret \
  --name "arbor-${E}/slack-signing-secret" \
  --secret-string "$SLACK_SIGNING_SECRET"

aws secretsmanager create-secret \
  --name "arbor-${E}/slack-bot-token" \
  --secret-string "$SLACK_BOT_TOKEN"

aws secretsmanager create-secret \
  --name "arbor-${E}/anthropic-api-key" \
  --secret-string "$ANTHROPIC_API_KEY"

aws secretsmanager create-secret \
  --name "arbor-${E}/google-credentials" \
  --secret-string "$(cat "$GOOGLE_CREDENTIALS_FILE")"

aws secretsmanager create-secret \
  --name "arbor-${E}/github-token" \
  --secret-string "$GITHUB_TOKEN"

echo "Secrets stored under arbor-${E}/*"


# =============================================================================
# 4. SQS
# =============================================================================

echo "--- 4. SQS ---"

QUEUE_URL=$(aws sqs create-queue \
  --queue-name "arbor-events-${E}" \
  --attributes '{
    "VisibilityTimeout":             "300",
    "MessageRetentionPeriod":        "86400",
    "ReceiveMessageWaitTimeSeconds": "20"
  }' \
  --query QueueUrl --output text)

QUEUE_ARN=$(aws sqs get-queue-attributes \
  --queue-url "$QUEUE_URL" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

echo "Queue: $QUEUE_URL"


# =============================================================================
# 5. IAM roles (Lambda execution, ECS execution, ECS task)
# =============================================================================
# These are the runtime roles used by the deployed services. They are separate
# from the deploy roles (arbor-deploy-dev / arbor-deploy-prod) created in
# Part 1, which are only assumed by GitHub Actions.

echo "--- 5. IAM roles ---"

# Lambda execution role
aws iam create-role \
  --role-name "arbor-lambda-role-${E}" \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

aws iam attach-role-policy \
  --role-name "arbor-lambda-role-${E}" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole

aws iam put-role-policy \
  --role-name "arbor-lambda-role-${E}" \
  --policy-name "arbor-lambda-policy-${E}" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {\"Effect\":\"Allow\",\"Action\":[\"sqs:SendMessage\"],\"Resource\":\"${QUEUE_ARN}\"},
      {\"Effect\":\"Allow\",\"Action\":[\"ecs:ListTasks\",\"ecs:RunTask\"],\"Resource\":\"*\"},
      {\"Effect\":\"Allow\",\"Action\":\"iam:PassRole\",\"Resource\":[\"arn:aws:iam::${AWS_ACCOUNT_ID}:role/arbor-ecs-task-role-${E}\",\"arn:aws:iam::${AWS_ACCOUNT_ID}:role/arbor-ecs-execution-role-${E}\"]},
      {\"Effect\":\"Allow\",\"Action\":\"secretsmanager:GetSecretValue\",\"Resource\":\"arn:aws:secretsmanager:${AWS_REGION}:${AWS_ACCOUNT_ID}:secret:arbor-${E}/*\"}
    ]
  }"

# ECS task execution role (pulls image, injects secrets at container start)
aws iam create-role \
  --role-name "arbor-ecs-execution-role-${E}" \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

aws iam attach-role-policy \
  --role-name "arbor-ecs-execution-role-${E}" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

aws iam put-role-policy \
  --role-name "arbor-ecs-execution-role-${E}" \
  --policy-name "arbor-ecs-execution-secrets-${E}" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Effect\": \"Allow\",
      \"Action\": \"secretsmanager:GetSecretValue\",
      \"Resource\": \"arn:aws:secretsmanager:${AWS_REGION}:${AWS_ACCOUNT_ID}:secret:arbor-${E}/*\"
    }]
  }"

# ECS task role (runtime permissions for the running container)
aws iam create-role \
  --role-name "arbor-ecs-task-role-${E}" \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

aws iam put-role-policy \
  --role-name "arbor-ecs-task-role-${E}" \
  --policy-name "arbor-ecs-task-policy-${E}" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Effect\": \"Allow\",
      \"Action\": [\"sqs:ReceiveMessage\",\"sqs:DeleteMessage\",\"sqs:GetQueueAttributes\"],
      \"Resource\": \"${QUEUE_ARN}\"
    }]
  }"

echo "IAM roles created."


# =============================================================================
# 6. ECS cluster, task definition, and service
# =============================================================================

echo "--- 6. ECS ---"

aws ecs create-cluster \
  --cluster-name "arbor-${E}" \
  --capacity-providers FARGATE

aws logs create-log-group --log-group-name "/ecs/arbor-agent-${E}"

# Build and push the initial image so the task definition has something to reference
REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

aws ecr get-login-password | docker login \
  --username AWS \
  --password-stdin "$REGISTRY"

docker build -t arbor-agent -f packages/agent/Dockerfile .
docker tag  arbor-agent "${REGISTRY}/arbor-agent:latest"
docker push "${REGISTRY}/arbor-agent:latest"

cat > /tmp/arbor-task-def-${E}.json <<TASKDEF
{
  "family": "arbor-agent-${E}",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "runtimePlatform": {"cpuArchitecture": "ARM64", "operatingSystemFamily": "LINUX"},
  "executionRoleArn": "arn:aws:iam::${AWS_ACCOUNT_ID}:role/arbor-ecs-execution-role-${E}",
  "taskRoleArn":      "arn:aws:iam::${AWS_ACCOUNT_ID}:role/arbor-ecs-task-role-${E}",
  "containerDefinitions": [{
    "name": "arbor-agent",
    "image": "${REGISTRY}/arbor-agent:latest",
    "essential": true,
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group":         "/ecs/arbor-agent-${E}",
        "awslogs-region":        "${AWS_REGION}",
        "awslogs-stream-prefix": "ecs"
      }
    },
    "secrets": [
      {"name":"DATABASE_URL",       "valueFrom":"arn:aws:secretsmanager:${AWS_REGION}:${AWS_ACCOUNT_ID}:secret:arbor-${E}/database-url"},
      {"name":"SLACK_BOT_TOKEN",    "valueFrom":"arn:aws:secretsmanager:${AWS_REGION}:${AWS_ACCOUNT_ID}:secret:arbor-${E}/slack-bot-token"},
      {"name":"ANTHROPIC_API_KEY",  "valueFrom":"arn:aws:secretsmanager:${AWS_REGION}:${AWS_ACCOUNT_ID}:secret:arbor-${E}/anthropic-api-key"},
      {"name":"GOOGLE_CREDENTIALS", "valueFrom":"arn:aws:secretsmanager:${AWS_REGION}:${AWS_ACCOUNT_ID}:secret:arbor-${E}/google-credentials"},
      {"name":"GITHUB_TOKEN",       "valueFrom":"arn:aws:secretsmanager:${AWS_REGION}:${AWS_ACCOUNT_ID}:secret:arbor-${E}/github-token"}
    ],
    "environment": [
      {"name":"SQS_QUEUE_URL", "value":"${QUEUE_URL}"},
      {"name":"AWS_REGION",    "value":"${AWS_REGION}"}
    ]
  }]
}
TASKDEF

TASK_DEF_ARN=$(aws ecs register-task-definition \
  --cli-input-json "file:///tmp/arbor-task-def-${E}.json" \
  --query 'taskDefinition.taskDefinitionArn' --output text)

# Migration task definition — short-lived task that runs drizzle-kit migrate
# and exits. The deploy workflow runs this before deploying code, keeping the
# DB inside the VPC and avoiding the need for external DB access from CI.
cat > /tmp/arbor-migrate-task-def-${E}.json <<MIGRATEDEF
{
  "family": "arbor-migrate-${E}",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "runtimePlatform": {"cpuArchitecture": "ARM64", "operatingSystemFamily": "LINUX"},
  "executionRoleArn": "arn:aws:iam::${AWS_ACCOUNT_ID}:role/arbor-ecs-execution-role-${E}",
  "taskRoleArn":      "arn:aws:iam::${AWS_ACCOUNT_ID}:role/arbor-ecs-task-role-${E}",
  "containerDefinitions": [{
    "name": "arbor-migrate",
    "image": "${REGISTRY}/arbor-agent:latest",
    "essential": true,
    "entryPoint": ["drizzle-kit", "migrate"],
    "workingDirectory": "/app/packages/db",
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group":         "/ecs/arbor-migrate-${E}",
        "awslogs-region":        "${AWS_REGION}",
        "awslogs-stream-prefix": "ecs"
      }
    }
  }]
}
MIGRATEDEF

aws logs create-log-group --log-group-name "/ecs/arbor-migrate-${E}"

aws ecs register-task-definition \
  --cli-input-json "file:///tmp/arbor-migrate-task-def-${E}.json"

# Create the ECS service. The deploy workflow calls update-service on subsequent
# deploys; the service must exist before the first CI run.
aws ecs create-service \
  --cluster "arbor-${E}" \
  --service-name "arbor-agent-${E}" \
  --task-definition "$TASK_DEF_ARN" \
  --desired-count 0 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={
    subnets=[${PRIVATE_SUBNET_A},${PRIVATE_SUBNET_B}],
    securityGroups=[${APP_SG}],
    assignPublicIp=DISABLED
  }"

echo "ECS cluster, task definition, and service created."


# =============================================================================
# 7. Lambda function and API Gateway
# =============================================================================

echo "--- 7. Lambda ---"

npm run build
test -d packages/lambda/dist || { echo "packages/lambda/dist not found"; exit 1; }
(cd packages/lambda/dist && zip -r ../lambda.zip .)

# Upload the initial zip to S3 (subsequent deploys upload by SHA)
aws s3 cp packages/lambda/lambda.zip \
  "s3://${ARTIFACT_BUCKET}/arbor-webhook/initial.zip"

LAMBDA_ARN=$(aws lambda create-function \
  --function-name "arbor-webhook-${E}" \
  --runtime nodejs22.x \
  --architectures arm64 \
  --role "arn:aws:iam::${AWS_ACCOUNT_ID}:role/arbor-lambda-role-${E}" \
  --handler index.handler \
  --code "S3Bucket=${ARTIFACT_BUCKET},S3Key=arbor-webhook/initial.zip" \
  --timeout 30 \
  --memory-size 256 \
  --vpc-config "SubnetIds=${PRIVATE_SUBNET_A},${PRIVATE_SUBNET_B},SecurityGroupIds=${APP_SG}" \
  --query FunctionArn --output text)

aws lambda wait function-active --function-name "arbor-webhook-${E}"

# Environment variables. DATABASE_URL and SLACK_SIGNING_SECRET are fetched from
# Secrets Manager at configuration time and stored as Lambda env vars; they will
# be visible in plaintext in the Lambda console. To avoid this, use the AWS
# Parameters and Secrets Lambda extension instead (requires code changes).
DB_URL=$(aws secretsmanager get-secret-value \
  --secret-id "arbor-${E}/database-url" --query SecretString --output text)
SIGNING_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id "arbor-${E}/slack-signing-secret" --query SecretString --output text)

aws lambda update-function-configuration \
  --function-name "arbor-webhook-${E}" \
  --environment "$(jq -n \
    --arg sqs     "$QUEUE_URL" \
    --arg cluster "arbor-${E}" \
    --arg family  "arbor-agent-${E}" \
    --arg taskdef "arbor-agent-${E}:1" \
    --arg subnets "${PRIVATE_SUBNET_A},${PRIVATE_SUBNET_B}" \
    --arg sgs     "$APP_SG" \
    --arg admins  "$ADMIN_USER_IDS" \
    --arg db      "$DB_URL" \
    --arg slack   "$SIGNING_SECRET" \
    '{Variables:{SQS_QUEUE_URL:$sqs,ECS_CLUSTER:$cluster,ECS_TASK_FAMILY:$family,ECS_TASK_DEFINITION:$taskdef,SUBNET_IDS:$subnets,SECURITY_GROUP_IDS:$sgs,ADMIN_USER_IDS:$admins,DATABASE_URL:$db,SLACK_SIGNING_SECRET:$slack}}')"

aws lambda wait function-updated --function-name "arbor-webhook-${E}"

echo "--- 7. API Gateway ---"

API_ID=$(aws apigatewayv2 create-api \
  --name "arbor-${E}" \
  --protocol-type HTTP \
  --query ApiId --output text)

aws lambda add-permission \
  --function-name "arbor-webhook-${E}" \
  --statement-id apigateway-invoke \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:${AWS_REGION}:${AWS_ACCOUNT_ID}:${API_ID}/*"

INTEGRATION_ID=$(aws apigatewayv2 create-integration \
  --api-id "$API_ID" \
  --integration-type AWS_PROXY \
  --integration-uri "$LAMBDA_ARN" \
  --payload-format-version 2.0 \
  --query IntegrationId --output text)

aws apigatewayv2 create-route \
  --api-id "$API_ID" \
  --route-key "POST /slack/events" \
  --target "integrations/${INTEGRATION_ID}"

aws apigatewayv2 create-route \
  --api-id "$API_ID" \
  --route-key "POST /slack/commands" \
  --target "integrations/${INTEGRATION_ID}"

aws apigatewayv2 create-stage \
  --api-id "$API_ID" \
  --stage-name '$default' \
  --auto-deploy

API_URL="https://${API_ID}.execute-api.${AWS_REGION}.amazonaws.com"

echo ""
echo "============================================================"
echo "${E} environment setup complete."
echo "API Gateway URL: $API_URL"
echo ""
echo "Add these as GitHub Actions secrets (Settings → Secrets):"
echo "  DATABASE_URL_${E^^}       = $DATABASE_URL"
echo "  API_URL_${E^^}            = $API_URL"
echo "  SUBNET_IDS_${E^^}         = $PRIVATE_SUBNET_A,$PRIVATE_SUBNET_B"
echo "  SECURITY_GROUP_ID_${E^^}  = $APP_SG"
echo ""
echo "Next steps:"
echo "  1. Configure your Slack ${E} app (see Slack App Configuration below)"
echo "  2. Configure your Slack ${E} app (see Slack App Configuration below)"
echo "       Events:   ${API_URL}/slack/events"
echo "       Commands: ${API_URL}/slack/commands"
echo "  3. Run the smoke test to verify"
echo "============================================================"
```

---

## GitHub Actions Secrets

After running both setup scripts, add the following secrets to the repository under **Settings → Secrets and variables → Actions**:

| Secret | Source | Used by |
|---|---|---|
| `AWS_REGION` | Your chosen region | Both workflows |
| `AWS_ACCOUNT_ID` | Printed by Part 1 script | Both workflows |
| `AWS_ROLE_DEV` | Printed by Part 1 script | `deploy-dev.yml` |
| `AWS_ROLE_PROD` | Printed by Part 1 script | `promote-prod.yml` |
| `LAMBDA_ARTIFACT_BUCKET` | Printed by Part 1 script | Both workflows |
| `DATABASE_URL_DEV` | Printed by Part 2 `ENV=dev` | `deploy-dev.yml` migrations |
| `DATABASE_URL_PROD` | Printed by Part 2 `ENV=prod` | `promote-prod.yml` migrations |
| `API_URL_DEV` | Printed by Part 2 `ENV=dev` | `deploy-dev.yml` smoke test |
| `API_URL_PROD` | Printed by Part 2 `ENV=prod` | `promote-prod.yml` smoke test |

---

## Slack App Configuration

These steps are done in the [Slack API console](https://api.slack.com/apps) and cannot be scripted. Create a separate Slack app for each environment to keep dev traffic out of production channels.

1. **Event Subscriptions** → enable, set Request URL to `<API_URL>/slack/events`, subscribe to the `app_mention` bot event.
2. **Slash Commands** → create `/squirrel-admin`, set Request URL to `<API_URL>/slack/commands`.
3. **OAuth & Permissions** → add bot token scopes: `app_mentions:read`, `chat:write`, `conversations:history`, `conversations:replies`.
4. Install the app to your workspace and copy the bot token into the `arbor-<env>/slack-bot-token` secret. If you've already run the setup script, update the secret: `aws secretsmanager put-secret-value --secret-id arbor-<env>/slack-bot-token --secret-string "xoxb-..."`.
5. Copy the Signing Secret from **Basic Information** into `arbor-<env>/slack-signing-secret`, and re-run the Lambda configuration update step to inject it as an env var.
6. Invite the bot to the channels where you want to use it.

---

## Social Post Approval

Per environment, after Part 2. See [Social Post Approval](social-posts.md).

1. **Migration.** Apply `packages/db/drizzle/0001_social_posts.sql` (the normal migrate task or `npm run db:migrate` includes it).
2. **Lambda env.** Add `SLACK_BOT_TOKEN` and `CRON_SECRET` to the Lambda configuration; add `SOCIAL_APPROVALS_CHANNEL` and `SOCIAL_APPROVER_IDS` to the agent task definition.
3. **API Gateway routes.** Add `POST /slack/interactions` and `POST /cron/social-nudge` with the same Lambda integration as the other routes.
4. **EventBridge schedule.** Scheduler cannot call an HTTP endpoint directly; use an EventBridge connection plus API destination, and a schedule rule that targets it every 15 minutes. The connection carries the `x-cron-secret` header (API key auth, key name `x-cron-secret`, value `$CRON_SECRET`):

```bash
CONN_ARN=$(aws events create-connection --name "arbor-social-nudge-${E}" \
  --authorization-type API_KEY \
  --auth-parameters "ApiKeyAuthParameters={ApiKeyName=x-cron-secret,ApiKeyValue=${CRON_SECRET}}" \
  --query ConnectionArn --output text)

DEST_ARN=$(aws events create-api-destination --name "arbor-social-nudge-${E}" \
  --connection-arn "$CONN_ARN" --http-method POST \
  --invocation-endpoint "${API_URL}/cron/social-nudge" \
  --query ApiDestinationArn --output text)

aws events put-rule --name "arbor-social-nudge-${E}" \
  --schedule-expression "rate(15 minutes)"
aws events put-targets --rule "arbor-social-nudge-${E}" \
  --targets "Id=nudge,Arn=${DEST_ARN},RoleArn=<role-with-events:InvokeApiDestination>"
```

A wrong or missing secret returns 401 and the nudge does not run.

5. **Slack app.** Add the `/propose-post` command and enable Interactivity (Request URL `<API_URL>/slack/interactions`); scopes `chat:write` and `commands`.

---

## Smoke Test

```bash
# Replace with the API_URL printed at the end of the setup script
API_URL="https://<your-api-id>.execute-api.<region>.amazonaws.com"

# Should return 401 — confirms Lambda is reachable and signature verification works
STATUS=$(curl -s -o /tmp/smoke -w "%{http_code}" -X POST "${API_URL}/slack/events" \
  -H "Content-Type: application/json" \
  -H "x-slack-request-timestamp: $(date +%s)" \
  -H "x-slack-signature: v0=badhash" \
  -d '{}')
echo "Status: $STATUS  Body: $(cat /tmp/smoke)"
# Expected: 401

# Should return 404 — confirms routing is live
curl -s -o /dev/null -w "%{http_code}" "${API_URL}/no-such-route-xyzzy"
# Expected: 404

# After mentioning @Squirrel in Slack, verify the ECS task started
aws ecs list-tasks --cluster "arbor-dev" --family "arbor-agent-dev" --desired-status RUNNING
```
