//! Stop flags for the virtual machine installs. Flashes have their own in
//! `FlashState`, which also keeps them to one at a time.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// The running installs, by the attempt the frontend named them with.
#[derive(Default)]
pub(crate) struct InstallJobs {
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

/// Keeps an attempt stoppable until it is dropped.
pub(crate) struct InstallJob<'a> {
    jobs: &'a InstallJobs,
    attempt: String,
    cancelled: Arc<AtomicBool>,
}

impl InstallJobs {
    /// Make `attempt` stoppable for as long as the returned job lives.
    pub(crate) fn begin(&self, attempt: String) -> InstallJob<'_> {
        let cancelled = Arc::new(AtomicBool::new(false));
        self.lock().insert(attempt.clone(), Arc::clone(&cancelled));
        InstallJob {
            jobs: self,
            attempt,
            cancelled,
        }
    }

    /// Ask `attempt` to stop. When it is not running (anymore), this does
    /// nothing, so a late stop can never hit a retry.
    pub(crate) fn cancel(&self, attempt: &str) {
        if let Some(cancelled) = self.lock().get(attempt) {
            cancelled.store(true, Ordering::Release);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
        self.running.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl InstallJob<'_> {
    /// The flag `cancel` sets for this attempt.
    pub(crate) fn cancelled(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancelled)
    }
}

impl Drop for InstallJob<'_> {
    fn drop(&mut self) {
        let mut running = self.jobs.lock();
        // Only remove our own entry, never one a reused attempt name put there
        if running
            .get(&self.attempt)
            .is_some_and(|cancelled| Arc::ptr_eq(cancelled, &self.cancelled))
        {
            running.remove(&self.attempt);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_reaches_only_a_running_attempt() {
        let jobs = InstallJobs::default();

        // Nothing runs: a stop now must not leak into the next install
        jobs.cancel("first");
        let first = jobs.begin("first".into());
        assert!(!first.cancelled().load(Ordering::Acquire));
        drop(first);

        let retry = jobs.begin("retry".into());
        // The first attempt's stop arrives late, while the retry runs
        jobs.cancel("first");
        assert!(!retry.cancelled().load(Ordering::Acquire));

        jobs.cancel("retry");
        assert!(retry.cancelled().load(Ordering::Acquire));
        drop(retry);
        assert!(jobs.lock().is_empty());
    }
}
