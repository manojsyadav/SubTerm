use std::net::{TcpStream, ToSocketAddrs, UdpSocket};
use std::time::Duration;

#[tauri::command]
pub async fn send_wake_on_lan(mac_address: String, broadcast_ip: Option<String>) -> Result<(), String> {
    let clean_mac = mac_address.replace([':', '-', '.'], "");
    if clean_mac.len() != 12 {
        return Err("MAC address must be 12 hexadecimal characters".to_string());
    }
    let mut mac_bytes = [0u8; 6];
    for i in 0..6 {
        mac_bytes[i] = u8::from_str_radix(&clean_mac[i * 2..i * 2 + 2], 16)
            .map_err(|e| format!("Invalid hex in MAC address: {}", e))?;
    }

    let mut packet = vec![0xFFu8; 6];
    for _ in 0..16 {
        packet.extend_from_slice(&mac_bytes);
    }

    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    socket.set_broadcast(true).map_err(|e| e.to_string())?;

    let target_ip = broadcast_ip.unwrap_or_else(|| "255.255.255.255".to_string());
    socket
        .send_to(&packet, format!("{}:9", target_ip))
        .map_err(|e| format!("Failed to send WoL packet: {}", e))?;
    let _ = socket.send_to(&packet, format!("{}:7", target_ip));

    Ok(())
}

#[tauri::command]
pub async fn perform_port_knock(
    host: String,
    ports: Vec<u16>,
    delay_ms: Option<u64>,
) -> Result<(), String> {
    if ports.is_empty() {
        return Err("No ports specified for port knock".to_string());
    }

    let delay = Duration::from_millis(delay_ms.unwrap_or(100));
    for port in ports {
        let addr = format!("{}:{}", host, port);
        if let Ok(mut addrs) = addr.to_socket_addrs() {
            if let Some(sock_addr) = addrs.next() {
                let _ = TcpStream::connect_timeout(&sock_addr, Duration::from_millis(150));
            }
        }
        tokio::time::sleep(delay).await;
    }

    Ok(())
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct PortProbeResult {
    pub host: String,
    pub port: u16,
    pub open: bool,
    pub latency_ms: u64,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn probe_tcp_port(
    host: String,
    port: u16,
    timeout_ms: Option<u64>,
) -> Result<PortProbeResult, String> {
    let t_ms = timeout_ms.unwrap_or(2000);
    let start = std::time::Instant::now();
    let addr_str = format!("{}:{}", host, port);

    let mut addrs = match tokio::net::lookup_host(&addr_str).await {
        Ok(a) => a,
        Err(e) => {
            return Ok(PortProbeResult {
                host,
                port,
                open: false,
                latency_ms: start.elapsed().as_millis() as u64,
                error: Some(format!("DNS lookup failed: {}", e)),
            })
        }
    };

    let target = match addrs.next() {
        Some(t) => t,
        None => {
            return Ok(PortProbeResult {
                host,
                port,
                open: false,
                latency_ms: start.elapsed().as_millis() as u64,
                error: Some("No socket address found".to_string()),
            })
        }
    };

    match tokio::time::timeout(
        std::time::Duration::from_millis(t_ms),
        tokio::net::TcpStream::connect(&target),
    )
    .await
    {
        Ok(Ok(_stream)) => {
            let elapsed = start.elapsed().as_millis() as u64;
            Ok(PortProbeResult {
                host,
                port,
                open: true,
                latency_ms: elapsed,
                error: None,
            })
        }
        Ok(Err(e)) => {
            let elapsed = start.elapsed().as_millis() as u64;
            Ok(PortProbeResult {
                host,
                port,
                open: false,
                latency_ms: elapsed,
                error: Some(e.to_string()),
            })
        }
        Err(_) => Ok(PortProbeResult {
            host,
            port,
            open: false,
            latency_ms: t_ms,
            error: Some(format!("Connection timed out after {}ms", t_ms)),
        }),
    }
}

#[tauri::command]
pub async fn batch_probe_ports(
    host: String,
    ports: Vec<u16>,
    timeout_ms: Option<u64>,
) -> Result<Vec<PortProbeResult>, String> {
    let mut results = Vec::new();
    for port in ports {
        let res = probe_tcp_port(host.clone(), port, timeout_ms).await?;
        results.push(res);
    }
    Ok(results)
}

