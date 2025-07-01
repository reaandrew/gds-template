#!/usr/bin/env python3
"""
AWS Inventory → MongoDB loader (v4-patched-3)
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
Fully handles ELB v1/v2, Auto Scaling Groups, Security Groups,
KMS keys, S3 buckets, EFS file-systems and Route 53 zones.
 
Changes in this patch:
• Adds `resource_type` to every document.
• Handles plain EC2 instance-ids gracefully.
• Fixes skipped EFS filesystems by mapping `FileSystemId`.
"""
 
from __future__ import annotations
 
import os
import sys
import logging
from typing import Dict, Any, Optional, Tuple, List
 
import jsonlines
from pymongo import MongoClient, ASCENDING, UpdateOne, errors
 
# ─────────────────────────────────────────────────────────────────────────────
# Import arn_utils no matter where we run from
# ─────────────────────────────────────────────────────────────────────────────
try:
    from queries.arn_utils import parse_arn_components, ARNParseError  # type: ignore
except ModuleNotFoundError:
    _HERE = os.path.dirname(os.path.abspath(__file__))  # …/scripts/python
    _ROOT = os.path.dirname(_HERE)                      # …/scripts
    sys.path.append(os.path.join(_ROOT, "queries"))
    from arn_utils import parse_arn_components, ARNParseError  # type: ignore
 
# ─────────────────────────────────────────────────────────────────────────────
# Config & logging
# ─────────────────────────────────────────────────────────────────────────────
MONGO_URI = "mongodb://localhost:27017/"
DATABASE_NAME = "aws_data"
 
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s: %(message)s",
)
logger = logging.getLogger(__name__)
 
# Map collection → unique-ID field
RESOURCE_ID_MAP: Dict[str, str] = {
    "ec2": "InstanceId",
    "autoscaling_groups": "AutoScalingGroupARN",
    "elb_v2": "LoadBalancerArn",          # ALB / NLB
    "elb_classic": "LoadBalancerName",    # synth-ARN later
    "security_groups": "GroupId",
    "kms_keys": "KeyArn",
    "kms_key_metadata": "KeyArn",         # NEW - KMS detailed metadata
    "elb_v2_listeners": "ListenerArn",    # NEW - ELB v2 listeners
    "elb_v2_certificates": "CertificateArn", # NEW - ELB v2 certificates
    "snapshots": "SnapshotId",
    "volumes": "VolumeId",
    "rds": "DBInstanceArn",
    "redshift_clusters": "ClusterNamespaceArn",
    "s3_buckets": "Name",                 # synth-ARN later
    "route53_zones": "Id",                # synth-ARN later
    "efs_filesystems": "FileSystemId",    # NEW – EFS
    "amis": "ImageId",
    "tags": "ResourceARN",                # informational
}
 
# ─────────────────────────────────────────────────────────────────────────────
# Mongo helpers
# ─────────────────────────────────────────────────────────────────────────────
def connect_to_mongo(uri: str) -> MongoClient:
    client = MongoClient(uri)
    logger.info("Connected to MongoDB at %s", uri)
    return client
 
 
def ensure_indexes(collection):
    try:
        collection.create_index(
            [
                ("year", ASCENDING),
                ("month", ASCENDING),
                ("day", ASCENDING),
                ("account_id", ASCENDING),
                ("resource_id", ASCENDING),
            ],
            unique=True,
        )
        collection.create_index("account_id")
        collection.create_index("resource_type")
    except errors.OperationFailure as e:
        logger.warning("Index creation failed for %s: %s", collection.name, e)
 
# ─────────────────────────────────────────────────────────────────────────────
# Generic helpers
# ─────────────────────────────────────────────────────────────────────────────
def dot_get(obj: Dict[str, Any], path: str) -> Optional[Any]:
    cur: Any = obj
    for part in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur
 
 
def resource_type_from_id(rid: str, fallback: str) -> str:
    """Return best-effort `resource_type` for *rid* (could be ARN or plain)."""
    rid = (rid or "").strip()
 
    if rid.lower().startswith("arn:"):
        try:
            return parse_arn_components(rid).resource_type
        except ARNParseError as exc:
            logger.debug("Malformed ARN %s – fallback to %s (%s)", rid, fallback, exc)
 
    if rid.startswith("i-") and fallback in {"ec2", "tags"}:
        return "instance"
 
    return fallback
 
# ─────────────────────────────────────────────────────────────────────────────
# Classic ELB ARN synthesiser
# ─────────────────────────────────────────────────────────────────────────────
def _classic_elb_arn(cfg: Dict[str, Any]) -> Optional[str]:
    name = cfg.get("LoadBalancerName")
    if not name:
        return None
 
    # Derive region
    region = None
    zones = cfg.get("AvailabilityZones", [])
    if zones:
        first = zones[0]
        if isinstance(first, str):
            region = first[:-1]  # "us-east-1a" → "us-east-1"
        elif isinstance(first, dict):
            region = first.get("ZoneName", "").rsplit("-", 1)[0]
    if not region and "DNSName" in cfg:
        parts = cfg["DNSName"].split(".")
        if len(parts) >= 4:
            region = parts[-4]
 
    account_id = (
            cfg.get("SourceSecurityGroup", {}).get("OwnerAlias")
            or cfg.get("CanonicalHostedZoneNameID")
            or "unknown"
    )
    return f"arn:aws:elasticloadbalancing:{region}:{account_id}:loadbalancer/{name}"
 
# ─────────────────────────────────────────────────────────────────────────────
# Resource-ID derivation
# ─────────────────────────────────────────────────────────────────────────────
def derive_resource_id(collection_name: str, cfg: Dict[str, Any]) -> Optional[str]:
    # 1. Direct ARN keys
    for key in ("Arn", "ARN", "ResourceArn", "resourceArn", "ResourceARN", "KeyArn"):
        if key in cfg and cfg[key]:
            return str(cfg[key])
 
    # 2. Collection-specific synthesis
    if collection_name == "elb_classic":
        return _classic_elb_arn(cfg)
    if collection_name == "s3_buckets":
        bucket = cfg.get("Name")
        return f"arn:aws:s3:::{bucket}" if bucket else None
    if collection_name == "route53_zones":
        zone = cfg.get("Id", "").split("/")[-1]
        return f"arn:aws:route53:::hostedzone/{zone}" if zone else None
 
    # 3. Simple mapped field
    field = RESOURCE_ID_MAP.get(collection_name)
    if field:
        val = dot_get(cfg, field)
        if val:
            return str(val)
 
    # 4. Redshift edge-case
    if collection_name == "redshift_clusters":
        return cfg.get("ClusterIdentifier")
 
    return None
 
# ─────────────────────────────────────────────────────────────────────────────
# Misc helpers
# ─────────────────────────────────────────────────────────────────────────────
def tags_array_to_dict(arr: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        str(t.get("Key", "")).lower(): t.get("Value") for t in (arr or []) if t.get("Key")
    }
 
 
def get_partition_details(fp: str, base: str) -> Tuple[int, int, int, str]:
    parts = os.path.relpath(fp, base).split(os.sep)
    year, month, day, account_id = int(parts[-5]), int(parts[-4]), int(parts[-3]), parts[-2]
    return year, month, day, account_id
 
 
def bulk_upsert(collection, batch: List[UpdateOne]):
    if not batch:
        return 0
    res = collection.bulk_write(batch, ordered=False)
    return (res.upserted_count or 0) + (res.modified_count or 0)
 
# ─────────────────────────────────────────────────────────────────────────────
# Per-file processors
# ─────────────────────────────────────────────────────────────────────────────
def process_tags_file(collection, fp: str, base: str):
    y, m, d, acct = get_partition_details(fp, base)
    batch: List[UpdateOne] = []
    skipped = written = 0
 
    with jsonlines.open(fp) as r:
        for mapping in r:
            rid = mapping.get("ResourceARN")
            if not rid:
                skipped += 1
                continue
            doc = {
                **mapping,
                "year": y,
                "month": m,
                "day": d,
                "account_id": acct,
                "resource_id": rid,
                "resource_type": resource_type_from_id(rid, collection.name),
                "tags": tags_array_to_dict(mapping.get("Tags", [])),
            }
            q = {
                "year": y,
                "month": m,
                "day": d,
                "account_id": acct,
                "resource_id": rid,
            }
            batch.append(UpdateOne(q, {"$set": doc}, upsert=True))
            if len(batch) >= 1000:
                written += bulk_upsert(collection, batch)
                batch.clear()
    written += bulk_upsert(collection, batch)
    logger.info("Upserted %d tag docs from %s (skipped %d)", written, fp, skipped)
 
 
def process_resource_file(collection, fp: str, base: str):
    y, m, d, acct = get_partition_details(fp, base)
    batch: List[UpdateOne] = []
    skipped = written = 0
 
    with jsonlines.open(fp) as r:
        for obj in r:
            cfg = obj.get("Configuration", {})
            
            # Special handling for new collections with custom structures
            if collection.name == "elb_v2_listeners":
                # Listeners have LoadBalancerArn and ListenerArn in Configuration
                rid = cfg.get("ListenerArn")
                # Extract account_id from LoadBalancerArn if available
                if cfg.get("LoadBalancerArn"):
                    try:
                        lb_parts = cfg["LoadBalancerArn"].split(":")
                        if len(lb_parts) >= 5:
                            acct = lb_parts[4]  # Override partition account_id
                    except Exception:
                        pass
            elif collection.name == "elb_v2_certificates":
                # Certificates have CertificateArn, ListenerArn, and LoadBalancerArn
                rid = cfg.get("CertificateArn")
                # Extract account_id from LoadBalancerArn if available
                if obj.get("LoadBalancerArn"):
                    try:
                        lb_parts = obj["LoadBalancerArn"].split(":")
                        if len(lb_parts) >= 5:
                            acct = lb_parts[4]  # Override partition account_id
                    except Exception:
                        pass
            else:
                # Standard resource ID derivation
                rid = derive_resource_id(collection.name, cfg)
            
            if not rid:
                skipped += 1
                continue
            doc = {
                **obj,
                "year": y,
                "month": m,
                "day": d,
                "account_id": acct,
                "resource_id": rid,
                "resource_type": resource_type_from_id(rid, collection.name),
            }
            q = {
                "year": y,
                "month": m,
                "day": d,
                "account_id": acct,
                "resource_id": rid,
            }
            batch.append(UpdateOne(q, {"$set": doc}, upsert=True))
            if len(batch) >= 1000:
                written += bulk_upsert(collection, batch)
                batch.clear()
    written += bulk_upsert(collection, batch)
    logger.info(
        "Upserted %d docs from %s into %s (skipped %d)",
        written,
        fp,
        collection.name,
        skipped,
    )
 
# ─────────────────────────────────────────────────────────────────────────────
# Main driver
# ─────────────────────────────────────────────────────────────────────────────
def main(base_path: str):
    client = connect_to_mongo(MONGO_URI)
    db = client[DATABASE_NAME]
 
    for root, _dirs, files in os.walk(base_path):
        for fname in files:
            if not fname.endswith(".json"):
                continue
            fp = os.path.join(root, fname)
            coll_name = fname.split(".")[0]
            coll = db[coll_name]
            ensure_indexes(coll)
 
            if coll_name == "tags":
                process_tags_file(coll, fp, base_path)
            else:
                process_resource_file(coll, fp, base_path)
 
    logger.info("All data ingestion complete.")
 
 
if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python bulk_insert_data.py <base_directory>")
        sys.exit(1)
    main(sys.argv[1])
