//! Normal TLS validation, with explicit session-only leaf certificate pinning.

use crate::error::{Error, Result};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{CertificateError, DigitallySignedStruct, SignatureScheme};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

const CERTIFICATE_CHANGED: &str =
    "Proxmox certificate changed. Reconnect and verify its fingerprint.";

pub(super) fn certificate_error(error: &reqwest::Error) -> Option<Error> {
    let mut source: &(dyn std::error::Error + 'static) = error;
    loop {
        let tls = source.downcast_ref::<rustls::Error>();
        if matches!(tls, Some(rustls::Error::General(message)) if message == CERTIFICATE_CHANGED) {
            return Some(Error::ProxmoxApi(CERTIFICATE_CHANGED.into()));
        }
        // io::Error::source skips its wrapped error, so inspect it explicitly.
        source = if let Some(inner) = source
            .downcast_ref::<std::io::Error>()
            .and_then(std::io::Error::get_ref)
        {
            inner
        } else {
            source.source()?
        };
    }
}

/// Only bare HTTPS origins are accepted, including normalized scheme casing.
pub fn server_url(value: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(value)
        .map_err(|_| Error::ProxmoxApi("Enter a valid HTTPS server URL".into()))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::ProxmoxApi(
            "Use an HTTPS server URL without credentials, a path, query, or fragment".into(),
        ));
    }
    Ok(url)
}

fn fingerprint(cert: &CertificateDer<'_>) -> String {
    Sha256::digest(cert.as_ref())
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::aws_lc_rs::default_provider())
}

fn client_builder(timeout: u64) -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        // A TLS proxy would present its own certificate to the same verifier.
        // Probe and authenticate directly so approval always identifies Proxmox.
        .no_proxy()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(timeout))
}

fn config(verifier: Arc<dyn ServerCertVerifier>) -> rustls::ClientConfig {
    rustls::ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .expect("default TLS protocol versions")
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth()
}

/// Build the client for a login/session. An absent pin uses normal platform trust.
pub(super) fn client(url: &str, pin: Option<&str>, timeout: u64) -> Result<reqwest::Client> {
    // Existing HTTP API fixtures are restricted to loopback in unit-test builds.
    #[cfg(test)]
    if let Ok(parsed) = reqwest::Url::parse(url) {
        if parsed.scheme() == "http" && parsed.host_str() == Some("127.0.0.1") {
            return reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(timeout))
                .build()
                .map_err(|e| Error::ProxmoxApi(e.to_string()));
        }
    }
    let url = server_url(url)?;
    let mut builder = client_builder(timeout);
    if let Some(pin) = pin {
        let bytes = hex::decode(pin.replace(':', ""))
            .map_err(|_| Error::ProxmoxApi("Invalid SHA-256 certificate fingerprint".into()))?;
        let pin: [u8; 32] = bytes.try_into().map_err(|_| {
            Error::ProxmoxApi("Invalid SHA-256 certificate fingerprint length".into())
        })?;
        let host = url
            .host_str()
            .expect("validated host")
            .trim_matches(['[', ']']);
        let verifier = PinnedVerifier {
            pin,
            server_name: ServerName::try_from(host.to_owned())
                .map_err(|_| Error::ProxmoxApi("Invalid server hostname".into()))?,
        };
        builder = builder.use_preconfigured_tls(config(Arc::new(verifier)));
    }
    builder
        .build()
        .map_err(|e| Error::ProxmoxApi(e.to_string()))
}

#[derive(Debug)]
struct PinnedVerifier {
    pin: [u8; 32],
    server_name: ServerName<'static>,
}

impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        cert: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        // Explicit approval vouches for this exact leaf, rather than its issuer/name.
        if server_name != &self.server_name || Sha256::digest(cert.as_ref())[..] != self.pin {
            return Err(rustls::Error::General(CERTIFICATE_CHANGED.into()));
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &provider().signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &provider().signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

#[derive(Debug)]
struct ProbeVerifier {
    normal: Arc<dyn ServerCertVerifier>,
    result: Mutex<Option<std::result::Result<Option<String>, String>>>,
}

// Apple exposes some issuer failures as an untyped Other error in platform-verifier.
// Re-evaluate with the native SSL policy to inspect status codes, never error text.
#[cfg(target_os = "macos")]
fn apple_unknown_issuer(
    cert: &CertificateDer<'_>,
    intermediates: &[CertificateDer<'_>],
    server_name: &ServerName<'_>,
    ocsp: &[u8],
    now: UnixTime,
) -> Option<bool> {
    use core_foundation::date::CFDate;
    use security_framework::{
        certificate::SecCertificate,
        policy::SecPolicy,
        secure_transport::SslProtocolSide,
        trust::{SecTrust, TrustResult},
    };
    use security_framework_sys::base;

    let certificates = std::iter::once(cert)
        .chain(intermediates)
        .map(|cert| SecCertificate::from_der(cert.as_ref()))
        .collect::<std::result::Result<Vec<_>, _>>()
        .ok()?;
    let policy = SecPolicy::create_ssl(SslProtocolSide::SERVER, Some(&server_name.to_str()));
    let mut trust = SecTrust::create_with_certificates(&certificates, &[policy]).ok()?;
    // CFAbsoluteTime starts on 2001-01-01, unlike UnixTime's 1970 epoch.
    let seconds = now.as_secs().checked_sub(978_307_200)?;
    trust
        .set_trust_verify_date(&CFDate::new(seconds as f64))
        .ok()?;
    if !ocsp.is_empty() {
        trust.set_trust_ocsp_response(std::iter::once(ocsp)).ok()?;
    }
    let error = trust.evaluate_with_error().err()?;
    // The safe wrapper exposes the trust result only through this older API.
    // Explicit user distrust (DENY), fatal failures, and other errors stay fatal.
    #[allow(deprecated)]
    let result = trust.evaluate().ok()?;
    Some(
        result == TrustResult::RECOVERABLE_TRUST_FAILURE
            && matches!(
                i32::try_from(error.code()).ok(),
                Some(base::errSecNotTrusted | base::errSecCreateChainFailed)
            ),
    )
}

fn verify_untrusted_chain(
    cert: &CertificateDer<'_>,
    intermediates: &[CertificateDer<'_>],
    server_name: &ServerName<'_>,
    ocsp: &[u8],
    now: UnixTime,
) -> std::result::Result<ServerCertVerified, rustls::Error> {
    // An unknown issuer may mask another problem. Temporarily anchor the supplied
    // chain for this probe only, retaining name, validity, EKU and signature checks.
    let parsed = rustls::server::ParsedCertificate::try_from(cert)?;
    rustls::client::verify_server_name(&parsed, server_name)?;
    if let Some(anchor) = intermediates.last() {
        // Trust-anchor conversion drops issuer validity and signing restrictions.
        let (_, parsed) = x509_parser::parse_x509_certificate(anchor.as_ref())
            .map_err(|_| CertificateError::BadEncoding)?;
        let is_ca = parsed
            .basic_constraints()
            .map_err(|_| CertificateError::BadEncoding)?
            .is_some_and(|constraints| constraints.value.ca);
        let forbids_signing = parsed
            .key_usage()
            .map_err(|_| CertificateError::BadEncoding)?
            .is_some_and(|usage| !usage.value.key_cert_sign());
        if !is_ca || forbids_signing {
            return Err(CertificateError::InvalidPurpose.into());
        }
        let validity = parsed.validity();
        let now = i128::from(now.as_secs());
        if now < i128::from(validity.not_before.timestamp()) {
            return Err(CertificateError::NotValidYet.into());
        }
        if now > i128::from(validity.not_after.timestamp()) {
            return Err(CertificateError::Expired.into());
        }
    }
    let mut roots = rustls::RootCertStore::empty();
    roots.add(intermediates.last().unwrap_or(cert).clone().into_owned())?;
    let verifier =
        rustls::client::WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider())
            .build()
            .map_err(|error| rustls::Error::General(error.to_string()))?;
    match verifier.verify_server_cert(cert, intermediates, server_name, ocsp, now) {
        // Proxmox can omit its private CA. WebPKI checks the leaf's validity,
        // basic constraints and EKU before searching for its issuer. Trust in the
        // missing issuer comes from fingerprint approval, not this probe. The
        // pinned login still verifies the TLS handshake's proof of key possession.
        Err(rustls::Error::InvalidCertificate(CertificateError::UnknownIssuer)) => {
            Ok(ServerCertVerified::assertion())
        }
        result => result,
    }
}

impl ServerCertVerifier for ProbeVerifier {
    fn verify_server_cert(
        &self,
        cert: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp: &[u8],
        now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        let result =
            match self
                .normal
                .verify_server_cert(cert, intermediates, server_name, ocsp, now)
            {
                Ok(_) => Ok(None),
                Err(error) => {
                    #[cfg(not(target_os = "macos"))]
                    let unknown_issuer = matches!(
                        error,
                        rustls::Error::InvalidCertificate(CertificateError::UnknownIssuer)
                    );
                    #[cfg(target_os = "macos")]
                    let unknown_issuer =
                        matches!(
                            error,
                            rustls::Error::InvalidCertificate(
                                CertificateError::UnknownIssuer | CertificateError::Other(_)
                            )
                        ) && apple_unknown_issuer(cert, intermediates, server_name, ocsp, now)
                            == Some(true);
                    if unknown_issuer {
                        verify_untrusted_chain(cert, intermediates, server_name, ocsp, now)
                            .map(|_| Some(fingerprint(cert)))
                            .map_err(|error| {
                                format!("Server certificate validation failed: {error}")
                            })
                    } else {
                        Err(format!("Server certificate validation failed: {error}"))
                    }
                }
            };
        *self.result.lock().expect("probe result lock") = Some(result);
        // Always abort here: even a trusted certificate probe must send no HTTP.
        Err(rustls::Error::General("certificate probe complete".into()))
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        self.normal.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        self.normal.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.normal.supported_verify_schemes()
    }
}

/// Inspect trust without sending HTTP or credentials. None means normal TLS trust;
/// a fingerprint requires explicit comparison and approval before authentication.
pub async fn certificate_fingerprint(url: &str) -> Result<Option<String>> {
    let url = server_url(url)?;
    let normal = rustls_platform_verifier::Verifier::new(provider())
        .map_err(|e| Error::ProxmoxApi(e.to_string()))?;
    probe(url, Arc::new(normal)).await
}

async fn probe(url: reqwest::Url, normal: Arc<dyn ServerCertVerifier>) -> Result<Option<String>> {
    let verifier = Arc::new(ProbeVerifier {
        normal,
        result: Mutex::new(None),
    });
    let client = client_builder(30)
        .use_preconfigured_tls(config(verifier.clone()))
        .build()
        .map_err(|e| Error::ProxmoxApi(e.to_string()))?;
    let _ = client.get(url).send().await;
    let result = verifier.result.lock().expect("probe result lock").take();
    result
        .unwrap_or_else(|| {
            Err("Could not inspect the server certificate. Check the URL and connection.".into())
        })
        .map_err(Error::ProxmoxApi)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ProxmoxCredentials, ProxmoxSession};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[derive(Debug)]
    struct UnknownIssuer;

    impl ServerCertVerifier for UnknownIssuer {
        fn verify_server_cert(
            &self,
            _cert: &CertificateDer<'_>,
            _intermediates: &[CertificateDer<'_>],
            _server_name: &ServerName<'_>,
            _ocsp: &[u8],
            _now: UnixTime,
        ) -> std::result::Result<ServerCertVerified, rustls::Error> {
            Err(CertificateError::UnknownIssuer.into())
        }

        fn verify_tls12_signature(
            &self,
            _message: &[u8],
            _cert: &CertificateDer<'_>,
            _dss: &DigitallySignedStruct,
        ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
            unreachable!("certificate-only fixture")
        }

        fn verify_tls13_signature(
            &self,
            _message: &[u8],
            _cert: &CertificateDer<'_>,
            _dss: &DigitallySignedStruct,
        ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
            unreachable!("certificate-only fixture")
        }

        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            unreachable!("certificate-only fixture")
        }
    }

    struct TlsServer {
        url: String,
        cert: CertificateDer<'static>,
        requests: Arc<Mutex<Vec<String>>>,
        acceptor: tokio_rustls::TlsAcceptor,
        rotate_to: Arc<Mutex<Option<tokio_rustls::TlsAcceptor>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for TlsServer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl TlsServer {
        async fn start(redirect: Option<String>, tls12: bool) -> Self {
            Self::start_at("127.0.0.1:0", redirect, tls12).await
        }

        async fn start_at(bind: &str, redirect: Option<String>, tls12: bool) -> Self {
            let rcgen::CertifiedKey { cert, signing_key } =
                rcgen::generate_simple_self_signed(vec!["localhost".into(), "127.0.0.1".into()])
                    .unwrap();
            let cert = cert.der().clone();
            let versions = if tls12 {
                vec![&rustls::version::TLS12]
            } else {
                vec![&rustls::version::TLS13]
            };
            let config = rustls::ServerConfig::builder_with_provider(provider())
                .with_protocol_versions(&versions)
                .unwrap()
                .with_no_client_auth()
                .with_single_cert(
                    vec![cert.clone()],
                    rustls::pki_types::PrivatePkcs8KeyDer::from(signing_key.serialize_der()).into(),
                )
                .unwrap();
            let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
            let listener = tokio::net::TcpListener::bind(bind).await.unwrap();
            let url = format!("https://{}", listener.local_addr().unwrap());
            let requests = Arc::new(Mutex::new(Vec::new()));
            let received = requests.clone();
            let rotate_to = Arc::new(Mutex::new(None));
            let next_acceptor = rotate_to.clone();
            let mut current_acceptor = acceptor.clone();
            let task = tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let Ok(Ok(mut tls)) = tokio::time::timeout(
                        std::time::Duration::from_secs(3),
                        current_acceptor.accept(stream),
                    )
                    .await
                    else {
                        continue;
                    };
                    let mut request = Vec::new();
                    loop {
                        let mut buf = [0; 4096];
                        let Ok(Ok(size)) = tokio::time::timeout(
                            std::time::Duration::from_secs(3),
                            tls.read(&mut buf),
                        )
                        .await
                        else {
                            break;
                        };
                        if size == 0 {
                            break;
                        }
                        request.extend_from_slice(&buf[..size]);
                        let text = String::from_utf8_lossy(&request);
                        if let Some((headers, body)) = text.split_once("\r\n\r\n") {
                            let len: usize = headers
                                .lines()
                                .find_map(|line| {
                                    line.to_lowercase()
                                        .strip_prefix("content-length: ")
                                        .and_then(|value| value.parse().ok())
                                })
                                .unwrap_or(0);
                            if body.len() >= len {
                                break;
                            }
                        }
                    }
                    let request = String::from_utf8(request).unwrap();
                    let body = if request.starts_with("POST /api2/json/access/ticket ") {
                        r#"{"data":{"ticket":"fixture-ticket","CSRFPreventionToken":"fixture-csrf"}}"#
                    } else if request.starts_with("GET /api2/json/version ") {
                        r#"{"data":{"version":"8.4.1"}}"#
                    } else {
                        r#"{"data":[]}"#
                    };
                    received.lock().unwrap().push(request);
                    let response = if let Some(location) = &redirect {
                        format!("HTTP/1.1 307 Temporary Redirect\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    } else {
                        format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
                    };
                    let _ = tls.write_all(response.as_bytes()).await;
                    let _ = tls.shutdown().await;
                    if let Some(replacement) = next_acceptor.lock().unwrap().take() {
                        current_acceptor = replacement;
                    }
                }
            });
            Self {
                url,
                cert,
                requests,
                acceptor,
                rotate_to,
                task,
            }
        }

        fn credentials(&self, approved: bool) -> ProxmoxCredentials {
            ProxmoxCredentials {
                server_url: self.url.clone(),
                username: "fixture@pam".into(),
                password: "fixture-password".into(),
                certificate_sha256: approved.then(|| fingerprint(&self.cert)),
            }
        }

        fn normal_verifier(&self) -> Arc<dyn ServerCertVerifier> {
            Arc::new(
                rustls_platform_verifier::Verifier::new_with_extra_roots(
                    [self.cert.clone()],
                    provider(),
                )
                .unwrap(),
            )
        }
    }

    #[test]
    fn validates_and_normalizes_server_origins() {
        for invalid in [
            "http://localhost",
            "ftp://localhost",
            "not a URL",
            "https://user:pass@localhost",
            "https://localhost/api",
            "https://localhost?foo",
            "https://localhost#foo",
        ] {
            assert!(server_url(invalid).is_err(), "{invalid}");
        }
        assert_eq!(
            server_url("HTTPS://PVE.EXAMPLE:8006").unwrap().as_str(),
            "https://pve.example:8006/"
        );
        assert!(server_url("https://[::1]:8006").is_ok());
        assert!(client("https://localhost", Some("01:02"), 1).is_err());
    }

    #[tokio::test]
    async fn untrusted_probe_sends_no_http_and_direct_login_sends_no_credentials() {
        let server = TlsServer::start(None, false).await;
        assert_eq!(
            certificate_fingerprint(&server.url).await.unwrap(),
            Some(fingerprint(&server.cert))
        );
        assert!(super::super::authenticate(&server.credentials(false))
            .await
            .is_err());
        assert!(server.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn trusted_probe_uses_normal_validation_and_sends_no_http() {
        let server = TlsServer::start(None, false).await;
        assert_eq!(
            probe(server_url(&server.url).unwrap(), server.normal_verifier())
                .await
                .unwrap(),
            None
        );
        assert!(server.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn trusted_issuer_does_not_bypass_hostname_or_expiry_errors() {
        let server = TlsServer::start(None, false).await;
        let expired = expired_certificate();
        let verifier = ProbeVerifier {
            normal: Arc::new(
                rustls_platform_verifier::Verifier::new_with_extra_roots(
                    [server.cert.clone(), expired.clone()],
                    provider(),
                )
                .unwrap(),
            ),
            result: Mutex::new(None),
        };
        for (cert, name, now) in [
            (&server.cert, "different.example", UnixTime::now()),
            (
                &expired,
                "localhost",
                UnixTime::since_unix_epoch(std::time::Duration::from_secs(1_640_995_200)),
            ),
        ] {
            assert!(verifier
                .verify_server_cert(cert, &[], &ServerName::try_from(name).unwrap(), &[], now)
                .is_err());
            assert!(verifier.result.lock().unwrap().take().unwrap().is_err());
        }
    }

    fn expired_certificate() -> CertificateDer<'static> {
        let key = rcgen::KeyPair::generate().unwrap();
        let mut params = rcgen::CertificateParams::new(vec!["localhost".into()]).unwrap();
        params.not_before = rcgen::date_time_ymd(2020, 1, 1);
        params.not_after = rcgen::date_time_ymd(2021, 1, 1);
        params.self_signed(&key).unwrap().der().clone()
    }

    #[tokio::test]
    async fn untrusted_issuer_does_not_hide_other_certificate_errors() {
        let server = TlsServer::start(None, false).await;
        let expired = expired_certificate();
        let verifier = ProbeVerifier {
            normal: Arc::new(rustls_platform_verifier::Verifier::new(provider()).unwrap()),
            result: Mutex::new(None),
        };
        let key = rcgen::KeyPair::generate().unwrap();
        let mut params = rcgen::CertificateParams::new(vec!["localhost".into()]).unwrap();
        params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ClientAuth];
        let wrong_usage = params.self_signed(&key).unwrap();
        let mut invalid_signature = server.cert.to_vec();
        *invalid_signature.last_mut().unwrap() ^= 1;
        let invalid_signature = CertificateDer::from(invalid_signature);
        for (cert, name, now) in [
            (&server.cert, "different.example", UnixTime::now()),
            (
                &expired,
                "localhost",
                UnixTime::since_unix_epoch(std::time::Duration::from_secs(1_640_995_200)),
            ),
            (wrong_usage.der(), "localhost", UnixTime::now()),
            (&invalid_signature, "localhost", UnixTime::now()),
        ] {
            assert!(verify_untrusted_chain(
                cert,
                &[],
                &ServerName::try_from(name).unwrap(),
                &[],
                now
            )
            .is_err());
            assert!(verifier
                .verify_server_cert(cert, &[], &ServerName::try_from(name).unwrap(), &[], now)
                .is_err());
            assert!(verifier.result.lock().unwrap().take().unwrap().is_err());
        }
    }

    #[test]
    fn untrusted_final_intermediate_retains_validity_checks() {
        let mut ca = rcgen::CertificateParams::new(Vec::new()).unwrap();
        ca.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        ca.not_before = rcgen::date_time_ymd(2020, 1, 1);
        ca.not_after = rcgen::date_time_ymd(2030, 1, 1);
        ca.distinguished_name
            .push(rcgen::DnType::CommonName, "Fixture root CA");
        let root = rcgen::Issuer::new(ca.clone(), rcgen::KeyPair::generate().unwrap());
        let name = ServerName::try_from("localhost").unwrap();
        let now = UnixTime::since_unix_epoch(std::time::Duration::from_secs(1_640_995_200));
        for (not_before, not_after, expected) in [
            (2020, 2030, None),
            (2020, 2021, Some(CertificateError::Expired)),
            (2023, 2030, Some(CertificateError::NotValidYet)),
        ] {
            let mut params = ca.clone();
            params.distinguished_name = rcgen::DistinguishedName::new();
            params
                .distinguished_name
                .push(rcgen::DnType::CommonName, "Fixture intermediate CA");
            params.not_before = rcgen::date_time_ymd(not_before, 1, 1);
            params.not_after = rcgen::date_time_ymd(not_after, 1, 1);
            let key = rcgen::KeyPair::generate().unwrap();
            let intermediate = params.signed_by(&key, &root).unwrap();
            let issuer = rcgen::Issuer::new(params, key);
            let mut params = rcgen::CertificateParams::new(vec!["localhost".into()]).unwrap();
            params.not_before = rcgen::date_time_ymd(2021, 7, 1);
            params.not_after = rcgen::date_time_ymd(2022, 7, 1);
            params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
            let leaf = params
                .signed_by(&rcgen::KeyPair::generate().unwrap(), &issuer)
                .unwrap();
            let intermediates = [intermediate.der().clone()];
            let result = verify_untrusted_chain(leaf.der(), &intermediates, &name, &[], now);
            match &expected {
                Some(error) => assert_eq!(
                    result.unwrap_err(),
                    rustls::Error::InvalidCertificate(error.clone()),
                    "intermediate validity {not_before}-{not_after}"
                ),
                None => assert!(result.is_ok(), "{result:?}"),
            }
            let normal: [Arc<dyn ServerCertVerifier>; 2] = [
                Arc::new(UnknownIssuer),
                Arc::new(rustls_platform_verifier::Verifier::new(provider()).unwrap()),
            ];
            for normal in normal {
                let verifier = ProbeVerifier {
                    normal,
                    result: Mutex::new(None),
                };
                assert!(verifier
                    .verify_server_cert(leaf.der(), &intermediates, &name, &[], now)
                    .is_err());
                let result = verifier.result.lock().unwrap().take().unwrap();
                if expected.is_none() {
                    assert_eq!(result.unwrap(), Some(fingerprint(leaf.der())));
                } else {
                    assert!(result.is_err(), "{result:?}");
                }
            }
        }
    }

    #[test]
    fn untrusted_final_intermediate_must_be_ca() {
        for is_ca in [rcgen::IsCa::ExplicitNoCa, rcgen::IsCa::NoCa] {
            assert_intermediate_signing_usage(is_ca, Vec::new(), false);
        }
    }

    #[test]
    fn untrusted_final_intermediate_must_allow_certificate_signing() {
        assert_intermediate_signing_usage(
            rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained),
            vec![rcgen::KeyUsagePurpose::DigitalSignature],
            false,
        );
    }

    #[test]
    fn untrusted_final_intermediate_accepts_ca_signing_usage() {
        for usages in [Vec::new(), vec![rcgen::KeyUsagePurpose::KeyCertSign]] {
            assert_intermediate_signing_usage(
                rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained),
                usages,
                true,
            );
        }
    }

    fn assert_intermediate_signing_usage(
        is_ca: rcgen::IsCa,
        key_usages: Vec<rcgen::KeyUsagePurpose>,
        allowed: bool,
    ) {
        let mut ca = rcgen::CertificateParams::new(Vec::new()).unwrap();
        ca.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        ca.distinguished_name
            .push(rcgen::DnType::CommonName, "Fixture root CA");
        let root = rcgen::Issuer::new(ca.clone(), rcgen::KeyPair::generate().unwrap());
        ca.distinguished_name = rcgen::DistinguishedName::new();
        ca.distinguished_name
            .push(rcgen::DnType::CommonName, "Fixture intermediate");
        ca.is_ca = is_ca;
        ca.key_usages = key_usages;
        let key = rcgen::KeyPair::generate().unwrap();
        let intermediate = ca.signed_by(&key, &root).unwrap();
        let issuer = rcgen::Issuer::new(ca, key);
        let leaf = rcgen::CertificateParams::new(vec!["localhost".into()])
            .unwrap()
            .signed_by(&rcgen::KeyPair::generate().unwrap(), &issuer)
            .unwrap();
        let intermediates = [intermediate.der().clone()];
        let name = ServerName::try_from("localhost").unwrap();
        let now = UnixTime::now();
        let result = verify_untrusted_chain(leaf.der(), &intermediates, &name, &[], now);
        assert_eq!(result.is_ok(), allowed, "chain verification: {result:?}");

        // Force the platform's unknown-issuer result to exercise the fallback,
        // regardless of which error a particular native trust store prioritizes.
        let verifier = ProbeVerifier {
            normal: Arc::new(UnknownIssuer),
            result: Mutex::new(None),
        };
        assert!(verifier
            .verify_server_cert(leaf.der(), &intermediates, &name, &[], now)
            .is_err());
        let result = verifier.result.lock().unwrap().take().unwrap();
        if allowed {
            assert_eq!(result.unwrap(), Some(fingerprint(leaf.der())));
        } else {
            assert!(result.is_err(), "must not offer approval: {result:?}");
        }
    }

    #[test]
    fn private_ca_leaf_without_issuer_can_be_approved_but_still_checks_name() {
        let mut ca = rcgen::CertificateParams::new(Vec::new()).unwrap();
        ca.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        ca.distinguished_name
            .push(rcgen::DnType::CommonName, "Fixture private CA");
        let issuer = rcgen::Issuer::new(ca, rcgen::KeyPair::generate().unwrap());
        let leaf = rcgen::CertificateParams::new(vec!["localhost".into()])
            .unwrap()
            .signed_by(&rcgen::KeyPair::generate().unwrap(), &issuer)
            .unwrap();
        let verifier = ProbeVerifier {
            normal: Arc::new(rustls_platform_verifier::Verifier::new(provider()).unwrap()),
            result: Mutex::new(None),
        };
        for (name, approved) in [("localhost", true), ("different.example", false)] {
            assert!(verifier
                .verify_server_cert(
                    leaf.der(),
                    &[],
                    &ServerName::try_from(name).unwrap(),
                    &[],
                    UnixTime::now()
                )
                .is_err());
            let result = verifier.result.lock().unwrap().take().unwrap();
            if approved {
                assert_eq!(result.unwrap(), Some(fingerprint(leaf.der())));
            } else {
                assert!(result.is_err());
            }
        }
    }

    #[tokio::test]
    async fn confirmed_certificate_authenticates_and_pins_subsequent_requests() {
        for tls12 in [false, true] {
            let server = TlsServer::start(None, tls12).await;
            let session = super::super::authenticate(&server.credentials(true))
                .await
                .unwrap();
            assert_eq!(session.certificate_sha256, Some(fingerprint(&server.cert)));
            assert!(super::super::list_nodes(&session).await.unwrap().is_empty());
            let requests = server.requests.lock().unwrap();
            assert_eq!(requests.len(), 3);
            assert!(requests[0].contains("password=fixture-password"));
            assert!(requests[2].contains("PVEAuthCookie=fixture-ticket"));
        }
    }

    #[tokio::test]
    async fn ipv6_certificate_pin_survives_credentials_and_session_serialization() {
        let server = TlsServer::start_at("[::1]:0", None, false).await;
        let credentials: ProxmoxCredentials =
            serde_json::from_value(serde_json::to_value(server.credentials(true)).unwrap())
                .unwrap();
        let session = super::super::authenticate(&credentials).await.unwrap();
        let session: ProxmoxSession =
            serde_json::from_value(serde_json::to_value(session).unwrap()).unwrap();
        assert_eq!(session.certificate_sha256, credentials.certificate_sha256);
        assert!(super::super::list_nodes(&session).await.is_ok());
        assert_eq!(server.requests.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn certificate_change_before_version_check_preserves_reconnect_message() {
        let original = TlsServer::start(None, false).await;
        let changed = TlsServer::start(None, false).await;
        *original.rotate_to.lock().unwrap() = Some(changed.acceptor.clone());

        let error = super::super::authenticate(&original.credentials(true))
            .await
            .unwrap_err();
        assert!(error.to_string().contains(CERTIFICATE_CHANGED), "{error}");
        let requests = original.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("POST /api2/json/access/ticket "));
    }

    #[tokio::test]
    async fn changed_certificate_rejects_password_and_session_ticket() {
        let original = TlsServer::start(None, false).await;
        let changed = TlsServer::start(None, false).await;
        let mut credentials = changed.credentials(true);
        credentials.certificate_sha256 = Some(fingerprint(&original.cert));
        assert!(super::super::authenticate(&credentials)
            .await
            .unwrap_err()
            .to_string()
            .contains(CERTIFICATE_CHANGED));
        let session = ProxmoxSession {
            server_url: changed.url.clone(),
            ticket: "fixture-ticket".into(),
            csrf_token: "fixture-csrf".into(),
            certificate_sha256: credentials.certificate_sha256,
        };
        let errors = [
            super::super::list_nodes(&session).await.unwrap_err(),
            super::super::list_storage(&session, "pve")
                .await
                .unwrap_err(),
            super::super::get_next_vm_id(&session).await.unwrap_err(),
            super::super::fetch_privileges(&session, "/")
                .await
                .unwrap_err(),
            super::super::wait_for_task(&session, "pve", "fixture-task", 1)
                .await
                .unwrap_err(),
            super::super::start_vm(&session, "pve", 100)
                .await
                .unwrap_err(),
            super::super::delete_import_image(&session, "pve", "local", "fixture.qcow2")
                .await
                .unwrap_err(),
        ];
        for error in errors {
            assert!(error.to_string().contains(CERTIFICATE_CHANGED), "{error}");
        }
        assert!(super::super::wait_for_vm_ip(&session, "pve", 100)
            .await
            .is_none());
        let config = crate::types::ProxmoxVmConfig {
            node: "pve".into(),
            storage: "local".into(),
            vm_id: 100,
            name: "fixture".into(),
            cpu_cores: 2,
            memory_mb: 2048,
            disk_size_gb: 32,
            auto_start: false,
        };
        let mut source_unused = false;
        let error = super::super::create_vm_with_disk(
            &session,
            &config,
            "fixture.qcow2",
            "local",
            &mut source_unused,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains(CERTIFICATE_CHANGED), "{error}");
        assert!(!source_unused);
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), b"fake fixture image").unwrap();
        let error = super::super::upload_image_to_proxmox(
            &session,
            "pve",
            &file.path().to_path_buf(),
            &crate::NoOpProgress,
            "local",
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains(CERTIFICATE_CHANGED), "{error}");
        assert!(changed.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn redirects_do_not_forward_passwords_or_tickets() {
        let destination = TlsServer::start(None, false).await;
        let server = TlsServer::start(Some(destination.url.clone()), false).await;
        assert!(super::super::authenticate(&server.credentials(true))
            .await
            .is_err());
        let session = ProxmoxSession {
            server_url: server.url.clone(),
            ticket: "fixture-ticket".into(),
            csrf_token: "fixture-csrf".into(),
            certificate_sha256: Some(fingerprint(&server.cert)),
        };
        assert!(super::super::list_nodes(&session).await.is_err());
        assert_eq!(server.requests.lock().unwrap().len(), 2);
        assert!(destination.requests.lock().unwrap().is_empty());
    }
}
