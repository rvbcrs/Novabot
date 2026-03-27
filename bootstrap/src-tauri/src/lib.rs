use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Start the Node.js server as a sidecar process
            let sidecar = app.shell()
                .sidecar("novabot-server")
                .expect("failed to create sidecar command");

            let (mut rx, _child) = sidecar
                .spawn()
                .expect("failed to spawn sidecar");

            // Log sidecar output in background
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            print!("[server] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Stderr(line) => {
                            eprint!("[server] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Terminated(status) => {
                            println!("[server] exited: {:?}", status);
                            break;
                        }
                        _ => {}
                    }
                }
            });

            println!("[tauri] Sidecar started — window loads http://localhost:7789");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {});
}
