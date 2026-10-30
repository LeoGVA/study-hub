"""
StudyHub Local Web Server & Data Sync
Serves the StudyHub app locally and automatically persists user study data to disk.
"""
import http.server
import socketserver
import os
import json
import webbrowser
import sys

# Ensure stdout and stderr handle utf-8 safely on Windows
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

PORT = 8000
DIRECTORY = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(DIRECTORY, "user_study_data.json")

class StudyHubRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def do_GET(self):
        if self.path == "/api/data":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            if os.path.exists(DATA_FILE):
                with open(DATA_FILE, "r", encoding="utf-8") as f:
                    self.wfile.write(f.read().encode("utf-8"))
            else:
                self.wfile.write(b"{}")
            return
        super().do_GET()

    def do_POST(self):
        if self.path == "/api/data":
            content_length = int(self.headers.get("Content-Length", 0))
            post_data = self.rfile.read(content_length)
            try:
                data = json.loads(post_data.decode("utf-8"))
                with open(DATA_FILE, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(b'{"status":"ok"}')
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(str(e).encode("utf-8"))
            return
        super().do_POST()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

def run_server():
    global PORT
    for p in range(PORT, PORT + 20):
        try:
            handler = StudyHubRequestHandler
            with socketserver.TCPServer(("", p), handler) as httpd:
                PORT = p
                url = f"http://localhost:{PORT}"
                local_ip = "127.0.0.1"
                try:
                    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                    s.connect(("8.8.8.8", 80))
                    local_ip = s.getsockname()[0]
                    s.close()
                except Exception:
                    pass
                print("=======================================================")
                print("  📘 StudyHub Web Server 起動中")
                print("=======================================================")
                print(f"  💻 このPCで開く:               {url}")
                print(f"  📱 iPad・スマホで開く(同Wi-Fi): http://{local_ip}:{PORT}")
                print(f"  📁 学習データ保存ファイル:      {DATA_FILE}")
                print("=======================================================")
                print("※ iPadで開く際は、PCと同じWi-Fiに接続してください。")
                print("※ サーバーを停止する場合は [Ctrl + C] を押してください。")
                print("=======================================================")
                # Open browser only if not in testing/daemon mode
                if "--no-browser" not in sys.argv:
                    webbrowser.open(url)
                httpd.serve_forever()
                break
        except OSError:
            continue

if __name__ == "__main__":
    run_server()
