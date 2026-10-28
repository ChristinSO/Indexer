"""Download clearly identified public sample photos into the ignored QA directory."""
import concurrent.futures
import json
from pathlib import Path
from urllib.request import urlopen, Request

ASSETS = [
    ("lake", "1470770841072-f978cf4d019e"), ("beach", "1507525428034-b723cf961d3e"),
    ("dog", "1517849845537-4d257902454a"), ("cat", "1514888286974-6c03e2ca1dba"),
    ("coffee", "1495474472287-4d71bcdd2085"), ("paris", "1502602898657-3e91760cbb34"),
    ("leaves", "1497250681960-ef046c08a56e"), ("car", "1503376780353-7e6692767b70"),
    ("forest", "1448375240586-882707db888b"), ("snow", "1464822759023-fed622ff2c3b"),
    ("flowers", "1490750967868-88aa4486c946"), ("city", "1519608487953-e999c86e7455"),
    ("food", "1565299624946-b28f40a0ae38"), ("ocean", "1518837695005-2083093ee35b"),
    ("desert", "1509316785289-025f5b846b35"), ("bicycle", "1485965120184-e220f721d03e"),
    ("books", "1507842217343-583bb7270b66"), ("waterfall", "1432405972618-c60b0225b8f9"),
    ("fruit", "1619566636858-adf3ef46400b"), ("sunset", "1472120435266-53107fd0c44a"),
]


def main():
    folder = Path(__file__).resolve().parent.parent / ".local" / "qa-photos"
    folder.mkdir(parents=True, exist_ok=True)
    def download(item):
        index, (label, photo) = item
        url = f"https://images.unsplash.com/photo-{photo}?auto=format&fit=max&w=1100&q=85"
        target = folder / f"{index:02}.jpg"
        if not target.exists():
            with urlopen(Request(url, headers={"User-Agent": "IndexerAlpha-QA/0.1"}), timeout=45) as response:
                target.write_bytes(response.read())
        return {"file": target.name, "expected_subject": label, "source": url}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(download, enumerate(ASSETS, 1)))
    (folder / "sources.json").write_text(json.dumps(results, indent=2))
    print(f"Downloaded {len(results)} sample photos for isolated QA, not the user library.")


if __name__ == "__main__":
    main()
