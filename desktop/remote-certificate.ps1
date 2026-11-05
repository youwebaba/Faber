$ErrorActionPreference = 'Stop'
$rsa = [System.Security.Cryptography.RSACng]::new(3072)
try {
  $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=Faber Remote', $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
  $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment, $true))
  $oids = [System.Security.Cryptography.OidCollection]::new()
  [void]$oids.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
  $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids, $true))
  $now = [DateTimeOffset]::UtcNow
  $certificate = $request.CreateSelfSigned($now.AddMinutes(-5), $now.AddYears(5))
  try {
    @{ pfx = [Convert]::ToBase64String($certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx)); certificate = [Convert]::ToBase64String($certificate.RawData) } | ConvertTo-Json -Compress
  } finally { $certificate.Dispose() }
} finally { $rsa.Dispose() }