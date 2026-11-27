#!/usr/bin/env bash
# destroy.sh — Tear down all AWS resources created by deploy.sh
# Run from the repo root: bash destroy.sh
set -euo pipefail

APP="likes-app"
REGION="${AWS_DEFAULT_REGION:-eu-north-1}"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
ECR_URI="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$APP"

echo "==> Destroying $APP in $REGION..."

# ECS service (scale to 0 first, then delete)
echo "==> Scaling down ECS service..."
aws ecs update-service --cluster "$APP" --service "$APP" --desired-count 0 \
  --region "$REGION" > /dev/null 2>&1 || true
aws ecs delete-service --cluster "$APP" --service "$APP" \
  --region "$REGION" --force > /dev/null 2>&1 || true

# ALB listener, target group, ALB
echo "==> Deleting ALB..."
ALB_ARN=$(aws elbv2 describe-load-balancers --region "$REGION" \
  --names "$APP-alb" --query "LoadBalancers[0].LoadBalancerArn" \
  --output text 2>/dev/null || true)
if [ -n "$ALB_ARN" ] && [ "$ALB_ARN" != "None" ]; then
  for L in $(aws elbv2 describe-listeners --region "$REGION" \
    --load-balancer-arn "$ALB_ARN" --query "Listeners[*].ListenerArn" --output text); do
    aws elbv2 delete-listener --listener-arn "$L" --region "$REGION" > /dev/null
  done
  aws elbv2 delete-load-balancer --load-balancer-arn "$ALB_ARN" --region "$REGION" > /dev/null
  echo "    Waiting for ALB to be deleted..."
  aws elbv2 wait load-balancer-deleted --load-balancer-arns "$ALB_ARN" --region "$REGION" 2>/dev/null || sleep 30
fi

TG_ARN=$(aws elbv2 describe-target-groups --region "$REGION" \
  --names "$APP-tg" --query "TargetGroups[0].TargetGroupArn" \
  --output text 2>/dev/null || true)
[ -n "$TG_ARN" ] && [ "$TG_ARN" != "None" ] && \
  aws elbv2 delete-target-group --target-group-arn "$TG_ARN" --region "$REGION" > /dev/null || true

# ECS cluster
echo "==> Deleting ECS cluster..."
aws ecs delete-cluster --cluster "$APP" --region "$REGION" > /dev/null 2>&1 || true

# EFS access points and mount targets
echo "==> Deleting EFS..."
EFS_ID=$(aws efs describe-file-systems --region "$REGION" \
  --query "FileSystems[?Tags[?Key=='Name' && Value=='$APP-efs']].FileSystemId | [0]" \
  --output text 2>/dev/null || true)
if [ -n "$EFS_ID" ] && [ "$EFS_ID" != "None" ]; then
  for AP in $(aws efs describe-access-points --region "$REGION" \
    --file-system-id "$EFS_ID" --query "AccessPoints[*].AccessPointId" --output text); do
    aws efs delete-access-point --access-point-id "$AP" --region "$REGION" > /dev/null
  done
  for MT in $(aws efs describe-mount-targets --region "$REGION" \
    --file-system-id "$EFS_ID" --query "MountTargets[*].MountTargetId" --output text); do
    aws efs delete-mount-target --mount-target-id "$MT" --region "$REGION" > /dev/null
  done
  echo "    Waiting for mount targets to be deleted..."
  sleep 20
  aws efs delete-file-system --file-system-id "$EFS_ID" --region "$REGION" > /dev/null
fi

# Security groups (delete in dependency order)
echo "==> Deleting security groups..."
VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" \
  --filters "Name=isDefault,Values=true" \
  --query "Vpcs[0].VpcId" --output text)
for SG_NAME in "$APP-ecs-sg" "$APP-efs-sg" "$APP-alb-sg"; do
  SG_ID=$(aws ec2 describe-security-groups --region "$REGION" \
    --filters "Name=group-name,Values=$SG_NAME" "Name=vpc-id,Values=$VPC_ID" \
    --query "SecurityGroups[0].GroupId" --output text 2>/dev/null || true)
  if [ -n "$SG_ID" ] && [ "$SG_ID" != "None" ]; then
    aws ec2 delete-security-group --group-id "$SG_ID" --region "$REGION" > /dev/null 2>&1 || \
      echo "    Could not delete $SG_NAME (may still have dependencies — retry later)"
  fi
done

# IAM role
echo "==> Deleting IAM role..."
aws iam detach-role-policy \
  --role-name "$APP-ecs-exec-role" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy 2>/dev/null || true
aws iam delete-role --role-name "$APP-ecs-exec-role" 2>/dev/null || true

# CloudWatch log group
echo "==> Deleting CloudWatch log group..."
aws logs delete-log-group --log-group-name "/ecs/$APP" --region "$REGION" 2>/dev/null || true

# ECR repository
echo "==> Deleting ECR repository..."
aws ecr delete-repository --repository-name "$APP" --region "$REGION" --force > /dev/null 2>&1 || true

echo ""
echo "✅ All resources deleted."
