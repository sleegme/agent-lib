"""Generates the static asset table."""

TABLE = {i: i * i for i in range(10)}


def main():
    for k, v in TABLE.items():
        print(f"{k},{v}")
