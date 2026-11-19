//! Анализ крашей: по логу и crash-report находим вероятную причину и подсказку

use std::path::Path;
use std::time::{Duration, SystemTime};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashHint {
    pub title: String,
    pub hint: String,
}

fn hint(title: &str, text: impl Into<String>) -> Option<CrashHint> {
    Some(CrashHint { title: title.into(), hint: text.into() })
}

/// Найти мод из имени mixin-конфига: "mixins.sodium.json" / "sodium.mixins.json"
fn mixin_mod(text: &str) -> Option<String> {
    let idx = text.find(".mixins.json").or_else(|| text.find("mixins.json"))?;
    let before = &text[..idx];
    let start = before
        .rfind(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.'))
        .map(|i| i + 1)
        .unwrap_or(0);
    let name = before[start..].trim_matches('.').trim_start_matches("mixins.");
    (!name.is_empty()).then(|| name.to_string())
}

/// Текст в одинарных кавычках после ключевого слова: "Replace mod 'Sodium' (sodium) 0.9.3" → ("Sodium", "0.9.3")
fn quoted_mod(line: &str) -> Option<(String, String)> {
    let start = line.find('\'')? + 1;
    let end = start + line[start..].find('\'')?;
    let name = line[start..end].to_string();
    let after = &line[end + 1..];
    let version = after
        .split_whitespace()
        .find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .unwrap_or("")
        .to_string();
    Some((name, version))
}

/// Перевод решения, которое предлагает Fabric Loader, в понятный совет
fn fabric_solution(text: &str) -> String {
    let lines: Vec<&str> = text.lines().map(str::trim).collect();
    for (i, line) in lines.iter().enumerate() {
        let line = line.trim_start_matches("- ");
        if line.starts_with("Replace mod") {
            if let Some((name, version)) = quoted_mod(line) {
                let wanted = line
                    .split(" with ")
                    .nth(1)
                    .map(|s| s.trim_end_matches(':').replace("any ", "").replace(" version that is compatible with", ""))
                    .unwrap_or_default();
                let with = lines
                    .get(i + 1)
                    .map(|l| l.trim_start_matches("- ").to_string())
                    .filter(|l| !l.is_empty() && !l.starts_with("More details"))
                    .map(|l| format!(" (совместимую с {l})"))
                    .unwrap_or_default();
                return format!(
                    "Замените «{name}» {version} на версию {wanted}{with}. Вкладка «Моды» → кнопка «Версия» у этого мода."
                );
            }
        }
        if line.starts_with("Install mod") {
            if let Some((name, version)) = quoted_mod(line) {
                return format!("Не хватает мода «{name}» {version}. Найдите его в каталоге и установите.");
            }
        }
        if line.starts_with("Remove mod") {
            if let Some((name, _)) = quoted_mod(line) {
                return format!("Удалите или отключите мод «{name}» во вкладке «Моды».");
            }
        }
    }
    "Не хватает зависимости или версии модов несовместимы друг с другом.".into()
}

pub fn analyze(text: &str) -> Option<CrashHint> {
    let has = |s: &str| text.contains(s);

    if has("java.lang.OutOfMemoryError") || has("Could not reserve enough space") {
        return hint(
            "Не хватило памяти",
            "Увеличьте ОЗУ в настройках сборки или закройте браузер и другие тяжёлые программы.",
        );
    }
    if has("UnsupportedClassVersionError") {
        return hint(
            "Мод требует более новую Java",
            "Один из модов собран под более свежую Java, чем нужна этой версии игры. Обновите мод или удалите его.",
        );
    }
    if has("Failed to locate library") || has("UnsatisfiedLinkError") {
        return hint(
            "Не загрузились нативные библиотеки",
            "Запустите сборку ещё раз — лаунчер заново распакует нативы. Если не помогло, обновите драйвер видеокарты.",
        );
    }
    if has("Pixel format not accelerated")
        || has("GLFW error 65542")
        || has("WGL: The driver does not appear to support OpenGL")
        || has("Couldn't set pixel format")
    {
        return hint(
            "Проблема с драйвером видеокарты",
            "Обновите драйвер видеокарты с сайта NVIDIA / AMD / Intel. На ноутбуке выберите дискретную видеокарту для java.exe.",
        );
    }
    if has("Incompatible mods found") || has("ModResolutionException") || has("requires any version of") {
        return hint("Несовместимые моды", fabric_solution(text));
    }
    if has("Mixin apply failed") || has("MixinApplyError") || has("InvalidMixinException") {
        return match mixin_mod(text) {
            Some(m) => hint(
                "Конфликт модов",
                format!("Мод «{m}» не смог встроиться в игру. Обновите его или временно отключите во вкладке «Моды»."),
            ),
            None => hint("Конфликт модов", "Один из модов несовместим с версией игры или с другим модом."),
        };
    }
    if has("Duplicate mod") || has("DuplicateModsFoundException") || has("found duplicate mods") {
        return hint("Мод установлен дважды", "Удалите повторяющиеся файлы модов во вкладке «Моды».");
    }
    if has("net.fabricmc") && has("NoClassDefFoundError") {
        return hint(
            "Не хватает Fabric API или библиотеки",
            "Похоже, моду нужна зависимость (чаще всего Fabric API). Найдите её во вкладке «Моды».",
        );
    }
    if has("Exception in server tick loop") {
        return hint("Ошибка в мире", "Игра упала при загрузке мира — попробуйте восстановить резервную копию мира.");
    }
    None
}

/// Свежий crash-report (созданный в последние пару минут)
pub fn latest_crash_report(game_dir: &Path) -> Option<String> {
    let dir = game_dir.join("crash-reports");
    let newest = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .max_by_key(|(t, _)| *t)?;
    let fresh = SystemTime::now().duration_since(newest.0).unwrap_or_default() < Duration::from_secs(180);
    fresh.then(|| std::fs::read_to_string(newest.1).ok()).flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_common_crashes() {
        assert_eq!(analyze("java.lang.OutOfMemoryError: Java heap space").unwrap().title, "Не хватило памяти");
        assert!(analyze("UnsatisfiedLinkError: Failed to locate library: lwjgl.dll").is_some());
        let mixin = analyze("Mixin apply failed sodium.mixins.json:features.Foo").unwrap();
        assert!(mixin.hint.contains("sodium"));
        assert!(analyze("all good").is_none());
    }

    #[test]
    fn explains_fabric_replace_solution() {
        let log = "Incompatible mods found!\n\
A potential solution has been determined, this may resolve your problem:\n\
\t - Replace mod 'Sodium' (sodium) 0.9.3-beta.5+mc26.3 with any 0.9.x version that is compatible with:\n\
\t\t - iris 1.11.7+mc26.3\n\
More details:";
        let h = analyze(log).unwrap();
        assert_eq!(h.title, "Несовместимые моды");
        assert!(h.hint.contains("«Sodium» 0.9.3-beta.5+mc26.3"), "{}", h.hint);
        assert!(h.hint.contains("0.9.x"), "{}", h.hint);
        assert!(h.hint.contains("iris 1.11.7+mc26.3"), "{}", h.hint);
    }
}
