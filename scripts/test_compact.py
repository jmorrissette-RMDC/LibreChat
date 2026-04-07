#!/usr/bin/env python3
"""
Integration test for context compaction.

Connects directly to henson-mongo, seeds a conversation with messages
from the session fixture, calls POST /api/convos/:id/compact, and
verifies the summary was written back to the DB.

Usage:
  python scripts/test_compact.py [--mongo-host HOST] [--api-url URL] [--token JWT]

Run on M5:
  docker exec henson-librechat python /workspace/henson/librechat/scripts/test_compact.py

Or from the host with port-forwarding:
  python scripts/test_compact.py --mongo-host 172.21.0.7 --api-url http://192.168.1.120:9225
"""

import argparse
import json
import os
import sys
import time
import uuid
import requests
from pymongo import MongoClient


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DEFAULT_MONGO = "mongodb://henson-mongo:27017/LibreChat"
DEFAULT_API   = "http://localhost:3080"
FIXTURE       = os.path.join(
    os.path.dirname(__file__),
    "../api/server/controllers/agents/__tests__/fixtures/conversation_large.txt",
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_fixture_messages(conversation_id, user_id, fixture_path=None):
    """Parse the fixture text file into MongoDB message documents."""
    with open(fixture_path or FIXTURE, "r", encoding="utf-8") as f:
        raw = f.read()

    blocks = [b.strip() for b in raw.split("\n\n") if b.strip()]
    messages = []
    parent = None
    for i, block in enumerate(blocks):
        role = "user" if block.startswith("User:") else "assistant"
        text = block.replace("User: ", "", 1).replace("Assistant: ", "", 1)
        msg_id = str(uuid.uuid4())
        doc = {
            "messageId":        msg_id,
            "conversationId":   conversation_id,
            "parentMessageId":  parent,
            "role":             role,
            "text":             text,
            "content":          text,
            "sender":           "user" if role == "user" else "assistant",
            "isCreatedByUser":  role == "user",
            "user":             user_id,
            "createdAt":        time.time() + i,
            "updatedAt":        time.time() + i,
            "unfinished":       False,
            "error":            False,
        }
        messages.append(doc)
        parent = msg_id

    return messages


def get_auth_token(api_url):
    """Log in and return a JWT. Uses the test account."""
    r = requests.post(f"{api_url}/api/auth/login", json={
        "email":    "j@rmdev.pro",
        "password": "Edgar01760",
    }, timeout=10)
    r.raise_for_status()
    return r.json().get("token")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mongo-host", default=DEFAULT_MONGO)
    parser.add_argument("--api-url",    default=DEFAULT_API)
    parser.add_argument("--token",      default=None, help="JWT (skips login)")
    parser.add_argument("--fixture",    default=None, help="Path to conversation fixture file")
    args = parser.parse_args()

    # --- Connect to MongoDB ---
    print(f"[1] Connecting to MongoDB: {args.mongo_host}")
    client = MongoClient(args.mongo_host, serverSelectionTimeoutMS=5000)
    db = client["LibreChat"]
    client.server_info()  # raises if unreachable
    print("    OK")

    # --- Get auth token first to resolve real user ID ---
    token = args.token
    if not token:
        print(f"[2] Logging in at {args.api_url}")
        try:
            token = get_auth_token(args.api_url)
            print("    OK")
        except Exception as e:
            print(f"    WARN: login failed ({e}), trying without auth")
            token = None

    # Resolve real user ID from DB so validateConvoAccess passes
    user_doc = db.users.find_one({"email": "j@rmdev.pro"})
    user_id = str(user_doc["_id"]) if user_doc else "test-user-compact"
    print(f"    User ID: {user_id}")

    # --- Seed conversation ---
    conversation_id = f"test-compact-{uuid.uuid4().hex[:8]}"

    print(f"[3] Seeding conversation {conversation_id}")
    fixture_path = args.fixture or FIXTURE
    messages = load_fixture_messages(conversation_id, user_id, fixture_path)
    db.messages.insert_many(messages)
    print(f"    Inserted {len(messages)} messages")

    # Also create a minimal conversation record
    db.conversations.insert_one({
        "conversationId": conversation_id,
        "user":           user_id,
        "title":          "Compact Test",
        "createdAt":      time.time(),
        "updatedAt":      time.time(),
    })

    # --- Call compact endpoint ---
    print(f"[4] POST {args.api_url}/api/convos/{conversation_id}/compact")  # noqa
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    headers["Content-Type"] = "application/json"
    r = requests.post(
        f"{args.api_url}/api/convos/{conversation_id}/compact",
        headers=headers,
        json={},
        timeout=60,
    )
    print(f"    Status: {r.status_code}")
    print(f"    Body:   {r.text[:200]}")
    r.raise_for_status()

    # --- Verify summary written to DB ---
    print("[5] Verifying summary in MongoDB")
    oldest = db.messages.find_one(
        {"conversationId": conversation_id},
        sort=[("createdAt", 1)],
    )
    if oldest and oldest.get("summary"):
        print(f"    PASS — summary on oldest message ({len(oldest['summary'])} chars):")
        print(f"    {oldest['summary'][:200]}")
    else:
        print("    FAIL — no summary found on oldest message")
        sys.exit(1)

    # --- Cleanup ---
    print("[6] Cleaning up test data")
    db.messages.delete_many({"conversationId": conversation_id})
    db.conversations.delete_one({"conversationId": conversation_id})
    print("    Done")

    print("\nPASS")


if __name__ == "__main__":
    main()
