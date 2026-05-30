def ask_keep_or_delete(position: int) -> bool:
    """Prompt in the terminal. Returns True to keep, False to delete and redo."""
    while True:
        ans = input(f"Position {position} done — keep or delete? [k/d]: ").strip().lower()
        if ans in ("k", "keep"):
            return True
        if ans in ("d", "delete"):
            return False
