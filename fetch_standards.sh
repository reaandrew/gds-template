#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# AWS Inventory Collection Script (Extended)
# ----------------------------------------------------------------------------
#   • Adds Load Balancers, Auto Scaling Groups, and Security Groups
# ----------------------------------------------------------------------------
set -euo pipefail
# ----------------------------- Configuration ---------------------------------
LOG_FILE="errors.log"
: > "$LOG_FILE"
exec 3>>"$LOG_FILE"
DATE_PATH=$(date -u '+%Y/%m/%d')
REGION="${AWS_REGION:-$(aws configure get region 2>>"$LOG_FILE" || echo "us-east-1")}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>>"$LOG_FILE")
BASE_DIR="output/$DATE_PATH/$ACCOUNT_ID"
mkdir -p "$BASE_DIR"
echo "Collecting AWS inventory for account $ACCOUNT_ID in $REGION …" | tee >(cat >&3)
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
# ---------------------------- Tag List (Raw Only) ----------------------------
TAG_RAW="$TMP_DIR/tags_raw.json"
echo "▶ Fetching tag data …" | tee >(cat >&3)
aws resourcegroupstaggingapi get-resources \
    --resource-type-filters \
      ec2:instance \
      elasticfilesystem:filesystem \
      rds:db \
      redshift:cluster \
      route53:hostedzone \
      s3:bucket \
      kms:key \
    --output json 2>>"$LOG_FILE" > "$TAG_RAW"
echo "▶ Saving raw tag list → tags.json" | tee >(cat >&3)
jq -c '.ResourceTagMappingList[]' "$TAG_RAW" > "$BASE_DIR/tags.json"
# ------------------------- Resource Collection Helper ------------------------
write_resource() {
  local cmd=$1
  local jq_filter=$2
  local outfile="$BASE_DIR/$3"
  printf "  • %-18s …\n" "${outfile##*/}" | tee >(cat >&3)
  eval "$cmd" 2>>"$LOG_FILE" | jq -c "$jq_filter" >> "$outfile" || {
    echo "[ERROR] Failed to process $outfile" >&3
    return 1
  }
}
# --------------------------- Resource Queries --------------------------------
write_resource \
  "aws ec2 describe-instances --no-paginate --output json" \
  '.Reservations[].Instances[] | {Configuration: .}' \
  "ec2.json"
write_resource \
  "aws rds describe-db-instances --output json" \
  '.DBInstances[] | {Configuration: .}' \
  "rds.json"
write_resource \
  "aws redshift describe-clusters --output json" \
  '.Clusters[] | {Configuration: .}' \
  "redshift_clusters.json"
write_resource \
  "aws ec2 describe-volumes --no-paginate --output json" \
  '.Volumes[] | {Configuration: .}' \
  "volumes.json"
write_resource \
  "aws efs describe-file-systems --output json" \
  '.FileSystems[] | {Configuration: .}' \
  "efs_filesystems.json"
write_resource \
  "aws kms list-keys --output json" \
  '.Keys[] | {Configuration: .}' \
  "kms_keys.json"
# KMS Key Metadata (for creation dates and other details)
echo "▶ Fetching KMS key metadata (parallel, limited to 200) …" | tee >(cat >&3)
KMS_METADATA_FILE="$TMP_DIR/kms_metadata.json"
: > "$KMS_METADATA_FILE"
# Limit to first 200 keys and process 5 at a time for performance
aws kms list-keys --query 'Keys[*].KeyId' --output text 2>>"$LOG_FILE" | \
tr '\t' '\n' | head -200 | \
xargs -I {} -P 5 -n 1 bash -c '
  key_id="$1"
  if [[ -n "$key_id" ]]; then
    printf "  • KMS Key: %s\n" "$key_id"
    aws kms describe-key --key-id "$key_id" --output json 2>/dev/null | \
      jq -c "{Configuration: .KeyMetadata}" >> "'"$KMS_METADATA_FILE"'" || {
        echo "[ERROR] Failed to describe KMS key $key_id" >&2
      }
  fi
' -- {}
if [[ -s "$KMS_METADATA_FILE" ]]; then
  cp "$KMS_METADATA_FILE" "$BASE_DIR/kms_key_metadata.json"
  echo "✔ KMS metadata saved → kms_key_metadata.json ($(wc -l < "$KMS_METADATA_FILE") keys)" | tee >(cat >&3)
else
  echo "[WARN] No KMS metadata collected" >&3
fi
write_resource \
  "aws route53 list-hosted-zones --output json" \
  '.HostedZones[] | {Configuration: .}' \
  "route53_zones.json"
write_resource \
  "aws s3api list-buckets --output json" \
  '.Buckets[] | {Configuration: .}' \
  "s3_buckets.json"
# Load Balancers - Classic ELB
write_resource \
  "aws elb describe-load-balancers --output json" \
  '.LoadBalancerDescriptions[] | {Configuration: .}' \
  "elb_classic.json"
# Load Balancers - Application/Network (ELBv2)
write_resource \
  "aws elbv2 describe-load-balancers --output json" \
  '.LoadBalancers[] | {Configuration: .}' \
  "elb_v2.json"
# ELB v2 Listeners (for TLS/SSL policy information)
echo "▶ Fetching ELB v2 listeners (parallel, limited to 100) …" | tee >(cat >&3)
ELB_LISTENERS_FILE="$TMP_DIR/elb_v2_listeners.json"
ELB_CERTS_FILE="$TMP_DIR/elb_v2_certificates.json"
: > "$ELB_LISTENERS_FILE"
: > "$ELB_CERTS_FILE"
# Limit to first 100 load balancers and process 3 at a time for performance
aws elbv2 describe-load-balancers --query 'LoadBalancers[*].LoadBalancerArn' --output text 2>>"$LOG_FILE" | \
tr '\t' '\n' | head -100 | \
xargs -I {} -P 3 -n 1 bash -c '
  lb_arn="$1"
  if [[ -n "$lb_arn" ]]; then
    printf "  • ELB v2: %s\n" "${lb_arn##*/}"
    
    # Get listeners for this load balancer
    aws elbv2 describe-listeners --load-balancer-arn "$lb_arn" --output json 2>/dev/null | \
      jq -c ".Listeners[] | {Configuration: ., LoadBalancerArn: \"$lb_arn\"}" >> "'"$ELB_LISTENERS_FILE"'" || {
        echo "[ERROR] Failed to get listeners for $lb_arn" >&2
      }
    
    # Get certificates for HTTPS/TLS listeners
    https_listeners=$(aws elbv2 describe-listeners --load-balancer-arn "$lb_arn" --query "Listeners[?Protocol==\`HTTPS\` || Protocol==\`TLS\`].ListenerArn" --output text 2>/dev/null || echo "")
    if [[ -n "$https_listeners" ]]; then
      echo "$https_listeners" | tr "\t" "\n" | while read -r listener_arn; do
        if [[ -n "$listener_arn" ]]; then
          printf "    • Certificates for: %s\n" "${listener_arn##*/}"
          aws elbv2 describe-listener-certificates --listener-arn "$listener_arn" --output json 2>/dev/null | \
            jq -c ".Certificates[] | {Configuration: ., ListenerArn: \"$listener_arn\", LoadBalancerArn: \"$lb_arn\"}" >> "'"$ELB_CERTS_FILE"'" || {
              echo "[ERROR] Failed to get certificates for $listener_arn" >&2
            }
        fi
      done
    fi
  fi
' -- {}
if [[ -s "$ELB_LISTENERS_FILE" ]]; then
  cp "$ELB_LISTENERS_FILE" "$BASE_DIR/elb_v2_listeners.json"
  echo "✔ ELB v2 listeners saved → elb_v2_listeners.json ($(wc -l < "$ELB_LISTENERS_FILE") listeners)" | tee >(cat >&3)
else
  echo "[WARN] No ELB v2 listeners collected" >&3
fi
if [[ -s "$ELB_CERTS_FILE" ]]; then
  cp "$ELB_CERTS_FILE" "$BASE_DIR/elb_v2_certificates.json"
  echo "✔ ELB v2 certificates saved → elb_v2_certificates.json ($(wc -l < "$ELB_CERTS_FILE") certificates)" | tee >(cat >&3)
else
  echo "[WARN] No ELB v2 certificates collected" >&3
fi
# Auto Scaling Groups
write_resource \
  "aws autoscaling describe-auto-scaling-groups --output json" \
  '.AutoScalingGroups[] | {Configuration: .}' \
  "autoscaling_groups.json"
# Security Groups
write_resource \
  "aws ec2 describe-security-groups --output json" \
  '.SecurityGroups[] | {Configuration: .}' \
  "security_groups.json"
# ------------------------------ Completion -----------------------------------
echo "✔ Inventory collection complete. Data stored in $BASE_DIR" | tee >(cat >&3)
