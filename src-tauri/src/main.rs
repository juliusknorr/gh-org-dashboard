#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, File};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::webview::NewWindowResponse;
use tauri::{Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

struct Server(Mutex<Option<Child>>);

// Apps started from Finder get a minimal PATH, the server needs gh, git and claude from the user's shell.
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let out = Command::new(shell)
        .args(["-lic", "printf '\\n__PATH__%s' \"$PATH\""])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    String::from_utf8(out.stdout).ok()?.rsplit_once("__PATH__").map(|(_, path)| path.trim().to_string())
}

// ponytail: macOS `open` only, switch to tauri-plugin-opener when other platforms matter
fn open_in_browser(url: &Url) {
    let _ = Command::new("open").arg(url.as_str()).spawn();
}

fn start_server(app: &tauri::App) -> Result<(Child, u16), Box<dyn std::error::Error>> {
    let resources = app.path().resource_dir()?;
    let data = app.path().app_data_dir()?;
    fs::create_dir_all(&data)?;
    let presets = data.join("presets.json");
    let port = TcpListener::bind("127.0.0.1:0")?.local_addr()?.port();
    let log = File::create(data.join("server.log"))?;
    let mut command = Command::new(std::env::current_exe()?.with_file_name("node"));
    command
        .arg(format!("--env-file-if-exists={}", data.join(".env").display()))
        .arg(resources.join("server/index.ts"))
        .env("PORT", port.to_string())
        .env("DATA_DIR", &data)
        .env("PRESETS_FILE", &presets)
        .stdout(log.try_clone()?)
        .stderr(log);
    if let Some(path) = login_shell_path() {
        command.env("PATH", path);
    }
    Ok((command.spawn()?, port))
}

fn wait_for(port: u16) {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline && TcpStream::connect(("127.0.0.1", port)).is_err() {
        thread::sleep(Duration::from_millis(200));
    }
}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let (child, port) = start_server(app)?;
            app.manage(Server(Mutex::new(Some(child))));
            let handle = app.handle().clone();
            thread::spawn(move || {
                wait_for(port);
                let url: Url = format!("http://127.0.0.1:{port}").parse().expect("valid url");
                let origin = url.origin();
                WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(url))
                    .title("GH Dashboard")
                    .inner_size(1400.0, 900.0)
                    .on_navigation(move |target| {
                        let external = matches!(target.scheme(), "http" | "https") && target.origin() != origin;
                        if external {
                            open_in_browser(target);
                        }
                        !external
                    })
                    .on_new_window(|target, _| {
                        open_in_browser(&target);
                        NewWindowResponse::Deny
                    })
                    .build()
                    .expect("failed to open the window");
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the app");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(mut child) = handle.state::<Server>().0.lock().unwrap().take() {
                let _ = child.kill();
            }
        }
    });
}
