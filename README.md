# SeceoKnight MDM
Mobile Device Management by SeceoKnight Technologies

## Server Requirements
- Ubuntu 22.04 LTS or newer
- 4 GB RAM, 2 CPU cores, 40 GB disk

## Deploy (3 commands only)

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh

# Clone repo
git clone https://github.com/Seceo-Knight/seceoknight-MDM
cd seceoknight-MDM

# Deploy (auto-detects your IP, creates .env, starts everything)
bash deploy.sh
```

## First Login
Open `http://<your-server-ip>` in browser.
- Email: `admin@mdm.local`
- Password: `ChangeMe!123`

## URLs
| Service | URL |
|---------|-----|
| MDM Dashboard | `http://<server-ip>` |
| Grafana | `http://<server-ip>:3001` |
| Traefik | `http://<server-ip>:8081` |
