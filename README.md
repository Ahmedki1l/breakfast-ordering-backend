# 🍳 Breakfast Ordering Platform — Backend

Node.js + Express + Socket.io backend for the Breakfast Ordering Platform.

## Setup

```bash
npm install
cp .env.example .env   # then edit with your keys
npm run dev
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `PORT` | Server port (default: 3000) | No |
| `FRONTEND_URL` | Frontend URL for CORS | Yes |
| `GEMINI_API_KEY` | Google Gemini API key for menu extraction | No |

## API Endpoints

### Sessions
- `POST /api/sessions` — Create a new order session
- `GET /api/sessions/:id` — Get session details
- `POST /api/sessions/:id/orders` — Submit/update an order
- `POST /api/sessions/:id/close` — Close a session

### Restaurants
- `GET /api/restaurants` — List restaurants (for dropdown)
- `GET /api/restaurants/:id` — Get restaurant with full menu

### Admin
- `GET /api/admin/restaurants` — List all restaurants
- `POST /api/admin/restaurants` — Create restaurant
- `PUT /api/admin/restaurants/:id` — Update restaurant
- `DELETE /api/admin/restaurants/:id` — Delete restaurant
- `POST /api/admin/restaurants/:id/menu-image` — Upload menu image
- `POST /api/admin/restaurants/:id/extract-menu` — AI extract menu
- `PUT /api/admin/restaurants/:id/menu-items` — Save menu items
