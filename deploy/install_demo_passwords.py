"""Initialize only disabled passwords in the copied release database."""

import os
import sys
from pathlib import Path

import django

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
django.setup()

from django.contrib.auth.hashers import make_password
from django.db import connection, transaction
from accounts.models import User


def main():
    password = os.environ["COLOGI_DEMO_PASSWORD"]
    if len(password) < 24 or os.environ.get("COLOGI_RELEASE_INSTALL") != "1":
        raise SystemExit("Release setup and a strong generated demo password are required.")
    with transaction.atomic(), connection.cursor() as cursor:
        cursor.execute("SELECT current_database(), current_user")
        database, role = cursor.fetchone()
        if (database, role) != ("cologi", "cologi_installer") and not database.startswith("test_cologi_cp13_install_"):
            raise SystemExit("Refusing to initialize passwords on this database.")
        accounts = list(User.objects.select_for_update().filter(is_active=True, password="!"))
        for user in accounts:
            user.password = make_password(password)
            user.save(update_fields=["password"])
        print(f"Initialized {len(accounts)} demo credentials.")


if __name__ == "__main__":
    main()
