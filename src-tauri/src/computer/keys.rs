//! Key-combo parsing ("cmd+shift+a", "return", "f5") into macOS virtual key codes and CGEvent
//! flag masks. Pure: unit-tested without touching the event system.

pub const FLAG_SHIFT: u64 = 0x0002_0000;
pub const FLAG_CONTROL: u64 = 0x0004_0000;
pub const FLAG_OPTION: u64 = 0x0008_0000;
pub const FLAG_COMMAND: u64 = 0x0010_0000;
pub const FLAG_FN: u64 = 0x0080_0000;

pub const KEY_RETURN: u16 = 36;
pub const KEY_TAB: u16 = 48;
pub const KEY_ESCAPE: u16 = 53;
pub const KEY_PERIOD: u16 = 47;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Combo { pub key: u16, pub flags: u64 }

/// ANSI-layout key codes (kVK_*). Shortcuts are matched by key position, so they keep working
/// while a Korean (or any other) input source is active.
fn key_code(name: &str) -> Option<u16> {
    let code = match name {
        "a" => 0, "s" => 1, "d" => 2, "f" => 3, "h" => 4, "g" => 5, "z" => 6, "x" => 7, "c" => 8, "v" => 9,
        "b" => 11, "q" => 12, "w" => 13, "e" => 14, "r" => 15, "y" => 16, "t" => 17,
        "1" => 18, "2" => 19, "3" => 20, "4" => 21, "6" => 22, "5" => 23, "=" | "equal" => 24, "9" => 25, "7" => 26,
        "-" | "minus" => 27, "8" => 28, "0" => 29, "]" => 30, "o" => 31, "u" => 32, "[" => 33, "i" => 34, "p" => 35,
        "l" => 37, "j" => 38, "'" | "quote" => 39, "k" => 40, ";" | "semicolon" => 41, "\\" | "backslash" => 42,
        "," | "comma" => 43, "/" | "slash" => 44, "n" => 45, "m" => 46, "." | "period" => 47, "`" | "grave" => 50,
        "return" | "enter" => 36, "tab" => 48, "space" => 49, "delete" | "backspace" => 51, "escape" | "esc" => 53,
        "forwarddelete" | "del" => 117, "home" => 115, "end" => 119, "pageup" => 116, "pagedown" => 121,
        "left" => 123, "right" => 124, "down" => 125, "up" => 126,
        "f1" => 122, "f2" => 120, "f3" => 99, "f4" => 118, "f5" => 96, "f6" => 97, "f7" => 98, "f8" => 100,
        "f9" => 101, "f10" => 109, "f11" => 103, "f12" => 111,
        _ => return None,
    };
    Some(code)
}

fn modifier(name: &str) -> Option<u64> {
    Some(match name {
        "cmd" | "command" | "meta" | "super" | "⌘" => FLAG_COMMAND,
        "ctrl" | "control" | "⌃" => FLAG_CONTROL,
        "alt" | "option" | "opt" | "⌥" => FLAG_OPTION,
        "shift" | "⇧" => FLAG_SHIFT,
        "fn" => FLAG_FN,
        _ => return None,
    })
}

/// Parses `cmd+c`, `Command+Shift+T`, `return`, `ctrl+alt+cmd+.`. Exactly one non-modifier key.
pub fn parse_combo(input: &str) -> Result<Combo, String> {
    let text = input.trim().to_lowercase();
    if text.is_empty() { return Err("키가 비어 있습니다. 예: cmd+c, return, escape".into()); }
    // "cmd++" means the plus key; split on '+' but keep a trailing literal '+'.
    let mut parts: Vec<String> = text.split('+').map(|s| s.trim().to_string()).collect();
    if text.ends_with("++") { parts.retain(|p| !p.is_empty()); parts.push("=".into()); }
    let mut flags = 0u64;
    let mut key: Option<u16> = None;
    for part in parts.iter().filter(|p| !p.is_empty()) {
        if let Some(flag) = modifier(part) { flags |= flag; continue; }
        let Some(code) = key_code(part) else { return Err(format!("알 수 없는 키: {part}")); };
        if key.is_some() { return Err(format!("키 조합에는 일반 키가 하나만 들어갈 수 있습니다: {input}")); }
        key = Some(code);
    }
    let key = key.ok_or_else(|| format!("수정 키만 있고 누를 키가 없습니다: {input}"))?;
    // Arrows and F-keys carry the fn/numeric-pad flag on real keyboards; some apps check it.
    if (123..=126).contains(&key) { flags |= 0x0020_0000 | FLAG_FN; }
    Ok(Combo { key, flags })
}

/// Keys still allowed while a password field has focus: moving out of it, never entering text.
pub fn allowed_in_secure_field(combo: &Combo) -> bool {
    matches!(combo.key, KEY_TAB | KEY_ESCAPE) && combo.flags & (FLAG_COMMAND | FLAG_CONTROL | FLAG_OPTION) == 0
}

/// Splits text into the units typed one event at a time: newline/tab become key presses,
/// everything else is sent as a Unicode string (works for Korean and emoji without an IME).
#[derive(Debug, PartialEq)]
pub enum TypeUnit { Key(u16), Text(Vec<u16>) }

pub fn type_units(text: &str) -> Vec<TypeUnit> {
    let mut out = Vec::new();
    for ch in text.chars() {
        match ch {
            '\n' => out.push(TypeUnit::Key(KEY_RETURN)),
            '\r' => {}
            '\t' => out.push(TypeUnit::Key(KEY_TAB)),
            _ => { let mut buf = [0u16; 2]; out.push(TypeUnit::Text(ch.encode_utf16(&mut buf).to_vec())); }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_combos() {
        assert_eq!(parse_combo("cmd+c").unwrap(), Combo { key: 8, flags: FLAG_COMMAND });
        assert_eq!(parse_combo("Command+Shift+T").unwrap(), Combo { key: 17, flags: FLAG_COMMAND | FLAG_SHIFT });
        assert_eq!(parse_combo("return").unwrap().key, 36);
        assert_eq!(parse_combo("ctrl+alt+cmd+.").unwrap(), Combo { key: KEY_PERIOD, flags: FLAG_CONTROL | FLAG_OPTION | FLAG_COMMAND });
        assert_eq!(parse_combo("cmd++").unwrap(), Combo { key: 24, flags: FLAG_COMMAND });
        assert!(parse_combo("left").unwrap().flags & FLAG_FN != 0);
    }

    #[test]
    fn rejects_bad_combos() {
        assert!(parse_combo("").is_err());
        assert!(parse_combo("cmd+shift").is_err());
        assert!(parse_combo("a+b").is_err());
        assert!(parse_combo("cmd+hyper").is_err());
    }

    #[test]
    fn secure_field_allows_only_leaving_keys() {
        assert!(allowed_in_secure_field(&parse_combo("tab").unwrap()));
        assert!(allowed_in_secure_field(&parse_combo("shift+tab").unwrap()));
        assert!(allowed_in_secure_field(&parse_combo("escape").unwrap()));
        assert!(!allowed_in_secure_field(&parse_combo("cmd+v").unwrap()));
        assert!(!allowed_in_secure_field(&parse_combo("a").unwrap()));
        assert!(!allowed_in_secure_field(&parse_combo("return").unwrap()));
    }

    #[test]
    fn type_units_are_unicode_safe() {
        let units = type_units("안녕\n😀");
        assert_eq!(units.len(), 4);
        assert_eq!(units[0], TypeUnit::Text(vec!['안' as u16]));
        assert_eq!(units[2], TypeUnit::Key(KEY_RETURN));
        assert_eq!(units[3], TypeUnit::Text("😀".encode_utf16().collect()));
    }
}
