use hai_core::{
    Error, ProgressCallback, ProxmoxBackend, ProxmoxBridge, ProxmoxCredentials, ProxmoxNode,
    ProxmoxSession, ProxmoxStorage, ProxmoxVmConfig, ProxmoxVmResult, Result,
};

// An external backend implementing only the original required methods still compiles.
struct ExistingBackend;

impl ProxmoxBackend for ExistingBackend {
    async fn authenticate(&self, _: &ProxmoxCredentials) -> Result<ProxmoxSession> {
        panic!("Certificate inspection must not authenticate")
    }

    async fn list_nodes(&self, _: &ProxmoxSession) -> Result<Vec<ProxmoxNode>> {
        unreachable!()
    }

    async fn list_storage(&self, _: &ProxmoxSession, _: &str) -> Result<Vec<ProxmoxStorage>> {
        unreachable!()
    }

    async fn list_bridges(&self, _: &ProxmoxSession, _: &str) -> Result<Vec<ProxmoxBridge>> {
        unreachable!()
    }

    async fn get_next_vm_id(&self, _: &ProxmoxSession) -> Result<u32> {
        unreachable!()
    }

    async fn create_vm<P: ProgressCallback>(
        &self,
        _: &ProxmoxSession,
        _: &ProxmoxVmConfig,
        _: &P,
    ) -> Result<ProxmoxVmResult> {
        unreachable!()
    }
}

#[tokio::test]
async fn certificate_inspection_defaults_to_an_error_not_platform_trust() {
    let result = ExistingBackend
        .certificate_fingerprint("https://pve.example:8006")
        .await;
    assert!(matches!(result, Err(Error::ProxmoxApi(message)) if message.contains("not supported")));
}

#[tokio::test]
async fn storage_import_defaults_to_an_error_not_a_change() {
    let session = ProxmoxSession {
        server_url: "https://pve.example:8006".to_string(),
        ticket: "ticket".to_string(),
        csrf_token: "csrf".to_string(),
        certificate_sha256: None,
    };
    let result = ExistingBackend
        .enable_storage_import(&session, "pve", "local")
        .await;
    assert!(matches!(result, Err(Error::ProxmoxApi(message)) if message.contains("not support")));
}
