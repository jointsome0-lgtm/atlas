use rustc_lexer::TokenKind;
use serde::Deserialize;
use serde_json::json;
use std::io::{self, Read};
use syn::visit::{self, Visit};

#[derive(Deserialize)]
struct Source {
    path: String,
    text: String,
    test_target: bool,
}

#[derive(Default)]
struct Inspect {
    test_code: bool,
    source_code: bool,
    tests: Vec<String>,
    errors: Vec<String>,
}

impl<'ast> Visit<'ast> for Inspect {
    fn visit_attribute(&mut self, attribute: &'ast syn::Attribute) {
        if attribute.path().is_ident("doc") {
            self.errors
                .push("Rust documentation attributes are forbidden".into());
        }
        if self.test_code && attribute.path().is_ident("path") {
            self.errors
                .push("tests must not load source through #[path]".into());
        }
        if self.source_code
            && attribute.path().is_ident("cfg")
            && let syn::Meta::List(list) = &attribute.meta
            && contains_ident(list.tokens.clone(), &["test"])
        {
            self.errors
                .push("test modules do not belong in src/".into());
        }
        visit::visit_attribute(self, attribute);
    }

    fn visit_macro(&mut self, value: &'ast syn::Macro) {
        if self.test_code
            && (value.path.segments.last().is_some_and(|segment| {
                matches!(
                    segment.ident.to_string().as_str(),
                    "include" | "include_str" | "include_bytes"
                )
            }) || contains_ident(
                value.tokens.clone(),
                &["include", "include_str", "include_bytes"],
            ))
        {
            self.errors
                .push("tests must use the public executable, not source inclusion".into());
        }
        visit::visit_macro(self, value);
    }

    fn visit_use_tree(&mut self, tree: &'ast syn::UseTree) {
        let name = match tree {
            syn::UseTree::Name(value) => Some(&value.ident),
            syn::UseTree::Rename(value) => Some(&value.ident),
            _ => None,
        };
        if self.test_code
            && name.is_some_and(|name| {
                matches!(
                    name.to_string().as_str(),
                    "include" | "include_str" | "include_bytes"
                )
            })
        {
            self.errors
                .push("tests must not import source-inclusion macros".into());
        }
        visit::visit_use_tree(self, tree);
    }

    fn visit_item_mod(&mut self, item: &'ast syn::ItemMod) {
        if self.source_code && item.ident == "tests" {
            self.errors
                .push("test modules do not belong in src/".into());
        }
        visit::visit_item_mod(self, item);
    }

    fn visit_item_fn(&mut self, function: &'ast syn::ItemFn) {
        if function.attrs.iter().any(|a| a.path().is_ident("test")) {
            if function.attrs.iter().any(|a| a.path().is_ident("ignore")) {
                self.errors.push("goal tests must not be ignored".into());
            }
            self.tests.push(function.sig.ident.to_string());
        }
        visit::visit_item_fn(self, function);
    }
}

fn contains_ident(tokens: proc_macro2::TokenStream, names: &[&str]) -> bool {
    tokens.into_iter().any(|token| match token {
        proc_macro2::TokenTree::Ident(ident) => names.iter().any(|name| ident == *name),
        proc_macro2::TokenTree::Group(group) => contains_ident(group.stream(), names),
        _ => false,
    })
}

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let sources: Vec<Source> = serde_json::from_str(&input).unwrap();
    let mut errors = Vec::new();
    let mut test_files = serde_json::Map::new();
    for source in sources {
        let mut offset = 0;
        for token in rustc_lexer::tokenize(&source.text) {
            if matches!(
                token.kind,
                TokenKind::LineComment | TokenKind::BlockComment { .. }
            ) {
                let line = source.text[..offset]
                    .bytes()
                    .filter(|b| *b == b'\n')
                    .count()
                    + 1;
                errors.push(format!(
                    "{}:{line}: Rust comments are forbidden",
                    source.path
                ));
            }
            offset += token.len;
        }
        match syn::parse_file(&source.text) {
            Ok(file) => {
                let mut inspection = Inspect {
                    test_code: source.path.starts_with("tests/"),
                    source_code: source.path.starts_with("src/"),
                    ..Inspect::default()
                };
                inspection.visit_file(&file);
                for error in inspection.errors {
                    errors.push(format!("{}: {error}", source.path));
                }
                if source.test_target {
                    if inspection.tests.is_empty() {
                        errors.push(format!(
                            "{}: Rust test target has no #[test] function",
                            source.path
                        ));
                    }
                    test_files.insert(source.path, json!(inspection.tests));
                } else if !inspection.tests.is_empty() {
                    errors.push(format!(
                        "{}: tests belong in goal-bound integration targets",
                        source.path
                    ));
                }
            }
            Err(error) => errors.push(format!("{}: invalid Rust syntax: {error}", source.path)),
        }
    }
    println!("{}", json!({"errors": errors, "test_files": test_files}));
}
