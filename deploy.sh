#!/usr/bin/env bash
# deploy.sh — Deploy likes-app to ECS Fargate + EFS + ALB on AWS
# Run from the repo root: bash deploy.sh
# Requires: AWS CLI v2, Docker, jq
set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────
APP="likes-app"
REGION="${AWS_DEFAULT_REGION:-eu-north-1}"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
IMAGE_TAG="latest"
CONTAINER_PORT=3456
# ─────────────────────────────────────────────────────────────────────────────

echo "==> Account: $ACCOUNT  Region: $REGION"

# ── 1. ECR — create repo and push image ──────────────────────────────────────
ECR_URI="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$APP"

echo "==> Creating ECR repository (idempotent)..."
aws ecr describe-repositories --repository-names "$APP" --region "$REGION" > /dev/null 2>&1 || \
  aws ecr create-repository --repository-name "$APP" --region "$REGION" \
    --image-scanning-configuration scanOnPush=true > /dev/null

echo "==> Logging Docker into ECR..."
aws ecr get-login-password --region "$REGION" | \
  docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

echo "==> Building Docker image..."
docker build --platform linux/amd64 -t "$APP:$IMAGE_TAG" .

echo "==> Tagging and pushing..."
docker tag "$APP:$IMAGE_TAG" "$ECR_URI:$IMAGE_TAG"
docker push "$ECR_URI:$IMAGE_TAG"

# ── 2. VPC — use the default VPC ─────────────────────────────────────────────
echo "==> Fetching default VPC..."
VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" \
  --filters "Name=isDefault,Values=true" \
  --query "Vpcs[0].VpcId" --output text)
echo "    VPC: $VPC_ID"

SUBNET_IDS=$(aws ec2 describe-subnets --region "$REGION" \
  --filters "Name=vpc-id,Values=$VPC_ID" \
  --query "Subnets[*].SubnetId" --output text | tr '\t' ',')
echo "    Subnets: $SUBNET_IDS"

# ── 3. Security Groups ────────────────────────────────────────────────────────
echo "==> Creating security group for ALB..."
ALB_SG_ID=$(aws ec2 describe-security-groups --region "$REGION" \
  --filters "Name=group-name,Values=$APP-alb-sg" "Name=vpc-id,Values=$VPC_ID" \
  --query "SecurityGroups[0].GroupId" --output text 2>/dev/null)

if [ "$ALB_SG_ID" = "None" ] || [ -z "$ALB_SG_ID" ]; then
  ALB_SG_ID=$(aws ec2 create-security-group --region "$REGION" \
    --group-name "$APP-alb-sg" \
    --description "ALB SG for $APP" \
    --vpc-id "$VPC_ID" \
    --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --region "$REGION" \
    --group-id "$ALB_SG_ID" --protocol tcp --port 80 --cidr 0.0.0.0/0
fi
echo "    ALB SG: $ALB_SG_ID"

echo "==> Creating security group for ECS tasks..."
ECS_SG_ID=$(aws ec2 describe-security-groups --region "$REGION" \
  --filters "Name=group-name,Values=$APP-ecs-sg" "Name=vpc-id,Values=$VPC_ID" \
  --query "SecurityGroups[0].GroupId" --output text 2>/dev/null)

if [ "$ECS_SG_ID" = "None" ] || [ -z "$ECS_SG_ID" ]; then
  ECS_SG_ID=$(aws ec2 create-security-group --region "$REGION" \
    --group-name "$APP-ecs-sg" \
    --description "ECS task SG for $APP" \
    --vpc-id "$VPC_ID" \
    --query GroupId --output text)
  # Allow traffic from ALB only
  aws ec2 authorize-security-group-ingress --region "$REGION" \
    --group-id "$ECS_SG_ID" --protocol tcp --port "$CONTAINER_PORT" \
    --source-group "$ALB_SG_ID"
fi
echo "    ECS SG: $ECS_SG_ID"

echo "==> Creating security group for EFS..."
EFS_SG_ID=$(aws ec2 describe-security-groups --region "$REGION" \
  --filters "Name=group-name,Values=$APP-efs-sg" "Name=vpc-id,Values=$VPC_ID" \
  --query "SecurityGroups[0].GroupId" --output text 2>/dev/null)

if [ "$EFS_SG_ID" = "None" ] || [ -z "$EFS_SG_ID" ]; then
  EFS_SG_ID=$(aws ec2 create-security-group --region "$REGION" \
    --group-name "$APP-efs-sg" \
    --description "EFS SG for $APP" \
    --vpc-id "$VPC_ID" \
    --query GroupId --output text)
  # Allow NFS from ECS tasks only
  aws ec2 authorize-security-group-ingress --region "$REGION" \
    --group-id "$EFS_SG_ID" --protocol tcp --port 2049 \
    --source-group "$ECS_SG_ID"
fi
echo "    EFS SG: $EFS_SG_ID"

# ── 4. EFS — persistent SQLite storage ───────────────────────────────────────
echo "==> Creating EFS filesystem..."
EFS_ID=$(aws efs describe-file-systems --region "$REGION" \
  --query "FileSystems[?Tags[?Key=='Name' && Value=='$APP-efs']].FileSystemId | [0]" \
  --output text)

if [ "$EFS_ID" = "None" ] || [ -z "$EFS_ID" ]; then
  EFS_ID=$(aws efs create-file-system --region "$REGION" \
    --performance-mode generalPurpose \
    --encrypted \
    --tags Key=Name,Value="$APP-efs" \
    --query FileSystemId --output text)
  echo "    Waiting for EFS to become available..."
  aws efs wait \
    --region "$REGION" \
    file-system-available --file-system-id "$EFS_ID" 2>/dev/null || \
    sleep 15  # fallback: wait 15 s if 'wait' subcommand is unsupported
fi
echo "    EFS: $EFS_ID"

echo "==> Creating EFS mount targets in each subnet..."
for SUBNET in $(echo "$SUBNET_IDS" | tr ',' ' '); do
  EXISTING=$(aws efs describe-mount-targets --region "$REGION" \
    --file-system-id "$EFS_ID" \
    --query "MountTargets[?SubnetId=='$SUBNET'].MountTargetId" \
    --output text)
  if [ -z "$EXISTING" ]; then
    aws efs create-mount-target --region "$REGION" \
      --file-system-id "$EFS_ID" \
      --subnet-id "$SUBNET" \
      --security-groups "$EFS_SG_ID" > /dev/null
    echo "    Created mount target in $SUBNET"
  else
    echo "    Mount target already exists in $SUBNET"
  fi
done

echo "==> Creating EFS access point..."
AP_ID=$(aws efs describe-access-points --region "$REGION" \
  --query "AccessPoints[?FileSystemId=='$EFS_ID' && Tags[?Key=='Name' && Value=='$APP-ap']].AccessPointId | [0]" \
  --output text)

if [ "$AP_ID" = "None" ] || [ -z "$AP_ID" ]; then
  AP_ID=$(aws efs create-access-point --region "$REGION" \
    --file-system-id "$EFS_ID" \
    --posix-user Uid=1000,Gid=1000 \
    --root-directory "Path=/data,CreationInfo={OwnerUid=1000,OwnerGid=1000,Permissions=755}" \
    --tags Key=Name,Value="$APP-ap" \
    --query AccessPointId --output text)
fi
echo "    EFS Access Point: $AP_ID"

# ── 5. IAM — ECS task execution role ─────────────────────────────────────────
echo "==> Creating ECS task execution role..."
EXEC_ROLE_NAME="$APP-ecs-exec-role"
EXEC_ROLE_ARN=$(aws iam get-role --role-name "$EXEC_ROLE_NAME" \
  --query Role.Arn --output text 2>/dev/null || true)

if [ -z "$EXEC_ROLE_ARN" ]; then
  EXEC_ROLE_ARN=$(aws iam create-role --role-name "$EXEC_ROLE_NAME" \
    --assume-role-policy-document '{
      "Version":"2012-10-17",
      "Statement":[{
        "Effect":"Allow",
        "Principal":{"Service":"ecs-tasks.amazonaws.com"},
        "Action":"sts:AssumeRole"
      }]
    }' --query Role.Arn --output text)
  aws iam attach-role-policy --role-name "$EXEC_ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
fi
echo "    Execution role: $EXEC_ROLE_ARN"

# ── 6. CloudWatch log group ───────────────────────────────────────────────────
LOG_GROUP="/ecs/$APP"
echo "==> Creating CloudWatch log group $LOG_GROUP..."
aws logs create-log-group --log-group-name "$LOG_GROUP" --region "$REGION" 2>/dev/null || true

# ── 7. ECS cluster ────────────────────────────────────────────────────────────
echo "==> Creating ECS cluster..."
aws ecs create-cluster --cluster-name "$APP" --region "$REGION" \
  --capacity-providers FARGATE \
  --default-capacity-provider-strategy capacityProvider=FARGATE,weight=1 > /dev/null 2>&1 || true
echo "    Cluster: $APP"

# ── 8. ECS task definition ────────────────────────────────────────────────────
echo "==> Registering ECS task definition..."
TASK_DEF_ARN=$(aws ecs register-task-definition --region "$REGION" \
  --family "$APP" \
  --network-mode awsvpc \
  --requires-compatibilities FARGATE \
  --cpu "512" \
  --memory "1024" \
  --execution-role-arn "$EXEC_ROLE_ARN" \
  --container-definitions "[
    {
      \"name\": \"$APP\",
      \"image\": \"$ECR_URI:$IMAGE_TAG\",
      \"portMappings\": [{\"containerPort\": $CONTAINER_PORT, \"protocol\": \"tcp\"}],
      \"environment\": [
        {\"name\": \"NODE_ENV\",       \"value\": \"production\"},
        {\"name\": \"PORT\",           \"value\": \"$CONTAINER_PORT\"},
        {\"name\": \"DB_FILE\",        \"value\": \"/data/data.sqlite\"},
        {\"name\": \"COOKIE_SECURE\",  \"value\": \"false\"}
      ],
      \"mountPoints\": [{
        \"sourceVolume\": \"efs-data\",
        \"containerPath\": \"/data\",
        \"readOnly\": false
      }],
      \"logConfiguration\": {
        \"logDriver\": \"awslogs\",
        \"options\": {
          \"awslogs-group\":         \"$LOG_GROUP\",
          \"awslogs-region\":        \"$REGION\",
          \"awslogs-stream-prefix\": \"ecs\"
        }
      },
      \"essential\": true
    }
  ]" \
  --volumes "[
    {
      \"name\": \"efs-data\",
      \"efsVolumeConfiguration\": {
        \"fileSystemId\": \"$EFS_ID\",
        \"transitEncryption\": \"ENABLED\",
        \"authorizationConfig\": {\"accessPointId\": \"$AP_ID\", \"iam\": \"DISABLED\"}
      }
    }
  ]" \
  --query "taskDefinition.taskDefinitionArn" --output text)
echo "    Task definition: $TASK_DEF_ARN"

# ── 9. ALB ────────────────────────────────────────────────────────────────────
SUBNET_LIST=$(echo "$SUBNET_IDS" | tr ',' ' ')

echo "==> Creating ALB..."
ALB_ARN=$(aws elbv2 describe-load-balancers --region "$REGION" \
  --names "$APP-alb" --query "LoadBalancers[0].LoadBalancerArn" \
  --output text 2>/dev/null || true)

if [ "$ALB_ARN" = "None" ] || [ -z "$ALB_ARN" ]; then
  ALB_ARN=$(aws elbv2 create-load-balancer --region "$REGION" \
    --name "$APP-alb" \
    --subnets $SUBNET_LIST \
    --security-groups "$ALB_SG_ID" \
    --scheme internet-facing \
    --type application \
    --query "LoadBalancers[0].LoadBalancerArn" --output text)
fi
echo "    ALB: $ALB_ARN"

echo "==> Creating target group..."
TG_ARN=$(aws elbv2 describe-target-groups --region "$REGION" \
  --names "$APP-tg" --query "TargetGroups[0].TargetGroupArn" \
  --output text 2>/dev/null || true)

if [ "$TG_ARN" = "None" ] || [ -z "$TG_ARN" ]; then
  TG_ARN=$(aws elbv2 create-target-group --region "$REGION" \
    --name "$APP-tg" \
    --protocol HTTP \
    --port "$CONTAINER_PORT" \
    --vpc-id "$VPC_ID" \
    --target-type ip \
    --health-check-path "/api/me" \
    --health-check-interval-seconds 30 \
    --healthy-threshold-count 2 \
    --unhealthy-threshold-count 3 \
    --matcher HttpCode=200-401 \
    --query "TargetGroups[0].TargetGroupArn" --output text)
fi
echo "    Target group: $TG_ARN"

echo "==> Creating ALB listener..."
aws elbv2 describe-listeners --region "$REGION" \
  --load-balancer-arn "$ALB_ARN" \
  --query "Listeners[?Port==\`80\`].ListenerArn" \
  --output text | grep -q arn || \
  aws elbv2 create-listener --region "$REGION" \
    --load-balancer-arn "$ALB_ARN" \
    --protocol HTTP --port 80 \
    --default-actions "Type=forward,TargetGroupArn=$TG_ARN" > /dev/null
echo "    Listener created on port 80"

# ── 10. ECS service ───────────────────────────────────────────────────────────
echo "==> Creating / updating ECS service..."
SERVICE_EXISTS=$(aws ecs describe-services --region "$REGION" \
  --cluster "$APP" --services "$APP" \
  --query "services[?status=='ACTIVE'].serviceName" --output text)

NETWORK_CONFIG="awsvpcConfiguration={subnets=[$SUBNET_IDS],securityGroups=[$ECS_SG_ID],assignPublicIp=ENABLED}"

if [ -z "$SERVICE_EXISTS" ]; then
  aws ecs create-service --region "$REGION" \
    --cluster "$APP" \
    --service-name "$APP" \
    --task-definition "$TASK_DEF_ARN" \
    --desired-count 1 \
    --launch-type FARGATE \
    --network-configuration "$NETWORK_CONFIG" \
    --load-balancers "targetGroupArn=$TG_ARN,containerName=$APP,containerPort=$CONTAINER_PORT" \
    --health-check-grace-period-seconds 60 > /dev/null
  echo "    Service created."
else
  aws ecs update-service --region "$REGION" \
    --cluster "$APP" \
    --service "$APP" \
    --task-definition "$TASK_DEF_ARN" \
    --force-new-deployment > /dev/null
  echo "    Service updated (new deployment triggered)."
fi

# ── 11. Print the app URL ─────────────────────────────────────────────────────
ALB_DNS=$(aws elbv2 describe-load-balancers --region "$REGION" \
  --load-balancer-arns "$ALB_ARN" \
  --query "LoadBalancers[0].DNSName" --output text)

echo ""
echo "✅ Deployment complete!"
echo ""
echo "   App URL : http://$ALB_DNS"
echo "   Login   : demo / demo1234"
echo ""
echo "   The ECS service is starting — allow ~2 minutes for the first task to become healthy."
echo "   Watch progress: aws ecs describe-services --cluster $APP --services $APP --region $REGION"
