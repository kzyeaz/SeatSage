import json
import logging

import httpx

from . import config

log = logging.getLogger(__name__)


class SearchIndex:
    """A rebuildable discovery index. SQL remains the source of truth."""

    def __init__(self):
        self.url = config.ELASTICSEARCH_URL.rstrip("/")
        self.ready = False

    def index(self, events):
        if not self.url:
            return
        try:
            with httpx.Client(timeout=4) as client:
                response = client.put(f"{self.url}/events", json={
                    "mappings": {"properties": {
                        "title": {"type": "text"}, "description": {"type": "text"},
                        "category": {"type": "keyword"}, "city": {"type": "text"},
                        "venue": {"type": "text"}, "tags": {"type": "text"},
                    }},
                })
                if response.status_code not in (200, 400):
                    response.raise_for_status()
                lines = []
                for event in events:
                    lines.extend([
                        json.dumps({"index": {"_index": "events", "_id": event["id"]}}),
                        json.dumps({k: event[k] for k in ("title", "description", "category", "city", "venue", "tags")}),
                    ])
                if lines:
                    response = client.post(
                        f"{self.url}/_bulk?refresh=true",
                        content="\n".join(lines) + "\n",
                        headers={"Content-Type": "application/x-ndjson"},
                    )
                    response.raise_for_status()
                    if response.json().get("errors"):
                        raise ValueError("Search indexing failed")
            self.ready = True
        except (httpx.HTTPError, ValueError):
            self.ready = False
            log.warning("Search index unavailable; discovery will use SQL.")

    def search(self, query):
        if not self.url or not self.ready:
            return None
        try:
            response = httpx.post(f"{self.url}/events/_search", timeout=2, json={
                "size": 1000,
                "query": {"multi_match": {
                    "query": query, "fields": ["title^3", "venue^2", "city", "description", "tags"],
                    "fuzziness": "AUTO", "operator": "and",
                }},
            })
            response.raise_for_status()
            return [hit["_id"] for hit in response.json()["hits"]["hits"]]
        except (httpx.HTTPError, ValueError, KeyError):
            return None
