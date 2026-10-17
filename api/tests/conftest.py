import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import Database
from app.inventory import LocalInventory
from app.seed import seed


@pytest.fixture
def database(tmp_path):
    db = Database(path=tmp_path / "test.db", url="")
    db.initialize()
    seed(db)
    return db


@pytest.fixture
def inventory(database):
    return LocalInventory(database, ttl=300)
