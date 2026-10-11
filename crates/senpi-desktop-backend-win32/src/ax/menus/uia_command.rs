//! Invokable command patterns, never SelectionItem or ExpandCollapse.

use super::super::uia_error;
use crate::menus::{failed, uia_command, UiaCommand};
use senpi_desktop_core::error::CoreResult;
use uiautomation::{
    patterns::{UIInvokePattern, UILegacyIAccessiblePattern, UITogglePattern},
    UIElement,
};

pub(super) enum Command {
    Invoke(UIInvokePattern),
    Legacy(UILegacyIAccessiblePattern),
    Toggle(UITogglePattern),
}

impl Command {
    pub fn new(element: &UIElement) -> CoreResult<Self> {
        let invoke = element.get_pattern::<UIInvokePattern>().ok();
        let legacy = if invoke.is_none() {
            element.get_pattern::<UILegacyIAccessiblePattern>().ok()
        } else {
            None
        };
        let action = legacy
            .as_ref()
            .map(|pattern| pattern.get_default_action().map_err(uia_error))
            .transpose()?;
        let toggle = if invoke.is_none() && legacy.is_none() {
            element.get_pattern::<UITogglePattern>().ok()
        } else {
            None
        };
        match uia_command(invoke.is_some(), action.as_deref(), toggle.is_some())? {
            UiaCommand::Invoke => invoke.map(Self::Invoke),
            UiaCommand::Legacy => legacy.map(Self::Legacy),
            UiaCommand::Toggle => toggle.map(Self::Toggle),
        }
        .ok_or_else(|| failed("UIA command pattern disappeared"))
    }

    pub fn run(self) -> CoreResult<()> {
        match self {
            Self::Invoke(pattern) => pattern.invoke(),
            Self::Legacy(pattern) => pattern.do_default_action(),
            Self::Toggle(pattern) => pattern.toggle(),
        }.map_err(|error| failed(format!("UIA menu command failed and may already have taken effect; do not replay automatically: {error}")))
    }
}
