# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "pyyaml",
# ]
# ///
"""Build a queryable JSON registry from normalized agent .md files."""

import argparse
import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import yaml

PLUGINS_ROOT = Path.home() / ".claude" / "plugins" / "local" / "legion-plugins"
DEFAULT_OUTPUT = Path.home() / ".claude" / "local" / "agents" / "registry.json"
AGENT_GLOB = "plugins/*/agents/*.md"

FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---", re.DOTALL)


def parse_frontmatter(filepath: Path) -> dict | None:
    """Extract YAML frontmatter from a markdown file."""
    text = filepath.read_text(encoding="utf-8")
    match = FRONTMATTER_RE.match(text)
    if not match:
        return None
    try:
        return yaml.safe_load(match.group(1))
    except yaml.YAMLError as exc:
        print(f"  WARN: YAML parse error in {filepath}: {exc}", file=sys.stderr)
        return None


def build_agent_entry(filepath: Path, frontmatter: dict) -> dict:
    """Build a single agent registry entry from frontmatter + file metadata."""
    rel_path = str(filepath.relative_to(PLUGINS_ROOT))
    stat = filepath.stat()
    last_modified = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()

    # Normalize tools: accept string or list
    tools = frontmatter.get("tools", [])
    if isinstance(tools, str):
        tools = [t.strip() for t in tools.split(",")]
    elif isinstance(tools, list):
        tools = [str(t).strip() for t in tools]
    else:
        tools = []

    return {
        "name": frontmatter.get("name", filepath.stem),
        "description": (frontmatter.get("description") or "").strip(),
        "model": frontmatter.get("model", "unknown"),
        "tools": tools,
        "type": frontmatter.get("type", "unknown"),
        "plugin": frontmatter.get("plugin", "unknown"),
        "color": frontmatter.get("color"),
        "schedule": frontmatter.get("schedule"),
        "file_path": rel_path,
        "last_modified": last_modified,
    }


def write_heartbeat(agent_name: str, status: str = "active") -> None:
    """Write a heartbeat file for an agent."""
    heartbeat_dir = Path.home() / ".claude" / "local" / "agents" / "heartbeats"
    heartbeat_dir.mkdir(parents=True, exist_ok=True)
    heartbeat_file = heartbeat_dir / f"{agent_name}.json"
    heartbeat_file.write_text(
        json.dumps(
            {
                "agent": agent_name,
                "status": status,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
            indent=2,
        )
    )


def build_registry() -> dict:
    """Scan all agent files and build the full registry."""
    agents = []
    skipped = []

    for filepath in sorted(PLUGINS_ROOT.glob(AGENT_GLOB)):
        frontmatter = parse_frontmatter(filepath)
        if frontmatter is None:
            skipped.append(str(filepath))
            continue
        entry = build_agent_entry(filepath, frontmatter)
        agents.append(entry)

    agents.sort(key=lambda a: a["name"])

    by_type = dict(Counter(a["type"] for a in agents).most_common())
    by_plugin = dict(Counter(a["plugin"] for a in agents).most_common())
    by_model = dict(Counter(a["model"] for a in agents).most_common())

    registry = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "agent_count": len(agents),
        "agents": agents,
        "by_type": by_type,
        "by_plugin": by_plugin,
        "by_model": by_model,
    }

    if skipped:
        registry["skipped"] = skipped

    return registry


def print_summary(registry: dict) -> None:
    """Print a human-readable summary."""
    print(f"Agent Registry: {registry['agent_count']} agents")
    print(f"Generated: {registry['generated_at']}")
    print()
    print("By type:")
    for t, count in registry["by_type"].items():
        print(f"  {t}: {count}")
    print()
    print("By plugin:")
    for p, count in registry["by_plugin"].items():
        print(f"  {p}: {count}")
    print()
    print("By model:")
    for m, count in registry["by_model"].items():
        print(f"  {m}: {count}")
    if registry.get("skipped"):
        print(f"\nSkipped (no frontmatter): {len(registry['skipped'])}")
        for s in registry["skipped"]:
            print(f"  {s}")


def main():
    parser = argparse.ArgumentParser(description="Build agent registry JSON")
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"Output path (default: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print summary without writing",
    )
    args = parser.parse_args()

    registry = build_registry()
    print_summary(registry)

    if args.dry_run:
        print("\n(dry run — not writing)")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(registry, indent=2) + "\n")
        print(f"\nWritten to: {args.output}")


if __name__ == "__main__":
    main()
