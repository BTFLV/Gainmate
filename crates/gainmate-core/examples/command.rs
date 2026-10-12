//! Developer-only JSON command adapter for integration testing the real engine.
//! Usage: echo '{"command":"analyze", ...}' | cargo run -p gainmate-core --example command
use gainmate_core::{
    analysis, import,
    model::*,
    normalize,
    process::{cancel_token, AudioTools},
    store::Store,
};
use serde_json::{json, Value};
use std::{io::Read, path::PathBuf};
fn execute(v: Value) -> anyhow::Result<Value> {
    let command = v["command"].as_str().unwrap_or_default();
    let root = PathBuf::from(
        v["root"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Test root required"))?,
    );
    let store = Store::open(root.join("test.sqlite"))?;
    let token = cancel_token();
    let tools = AudioTools::default();
    let paths: Vec<PathBuf> = serde_json::from_value(v["paths"].clone()).unwrap_or_default();
    match command {
        "import_paths" => Ok(serde_json::to_value(import::collect(&paths, &token)?)?),
        "analyze_files" => {
            let mut results = Vec::new();
            for path in paths {
                let a = if let Some(a) = store.cached(&path)? {
                    a
                } else {
                    let a = analysis::analyze(&tools, &path, &token)?;
                    store.cache(&a)?;
                    a
                };
                results.push(json!({"path":path,"analysis":a,"operation":null,"error":null}));
            }
            Ok(json!(results))
        }
        "track_detail" => Ok(json!(
            store.cached(&PathBuf::from(v["path"].as_str().unwrap()))?
        )),
        "save_session" => {
            store.save_session(&paths)?;
            Ok(Value::Null)
        }
        "load_session" => Ok(json!(store.session()?)),
        "history" => Ok(json!(store.history()?)),
        "read_rekordbox" => Ok(json!(import::read_rekordbox(&PathBuf::from(
            v["path"].as_str().unwrap()
        ))?)),
        "export_plan" | "normalize_files" => {
            let settings: Settings = serde_json::from_value(v["settings"].clone())?;
            let all: Vec<_> = paths
                .iter()
                .map(|p| {
                    store
                        .cached(p)?
                        .ok_or_else(|| anyhow::anyhow!("Analyze first"))
                })
                .collect::<anyhow::Result<_>>()?;
            let p = normalize::plan(&all, &settings)?;
            if command == "export_plan" {
                return Ok(json!(p));
            }
            let mut results = Vec::new();
            for (a, item) in all.iter().zip(&p.items) {
                match normalize::normalize(&tools,&store,a,&settings,item,&token){Ok(op)=>results.push(json!({"path":a.path,"analysis":store.cached(&a.path)?,"operation":op,"error":null})),Err(e)=>results.push(json!({"path":a.path,"analysis":null,"operation":null,"error":e.to_string()}))}
            }
            Ok(json!(results))
        }
        "restore_backup" => Ok(json!(normalize::restore(
            &store,
            v["id"].as_str().unwrap(),
            &token
        )?)),
        _ => anyhow::bail!("Unsupported developer command: {command}"),
    }
}
fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let result = serde_json::from_str(&input)
        .map_err(anyhow::Error::from)
        .and_then(execute);
    match result {
        Ok(v) => println!("{}", json!({"ok":v})),
        Err(e) => {
            println!("{}", json!({"error":format!("{e:#}")}));
            std::process::exit(1)
        }
    }
}
