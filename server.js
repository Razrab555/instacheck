require('dotenv').config();

if (!process.env.SOCIALAPIS_TOKEN) {
  console.error('CRITICAL: SOCIALAPIS_TOKEN is not set');
  process.exit(1);
}

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Единственный рабочий эндпоинт
app.get('/api/analyze', async (req, res) => {
  const { username } = req.query;
  if (!username || !/^[a-zA-Z0-9._]{1,30}$/.test(username)) {
    return res.status(400).json({ error: 'Некорректный username' });
  }

  try {
    const response = await axios.get(`https://api.socialapis.io/instagram/profile/details`, {
      params: { username: username },
      headers: { 'x-api-token': process.env.SOCIALAPIS_TOKEN },
      timeout: 10000
    });
    
    const data = response.data?.data || response.data;
    
    if (data.is_private) {
      return res.status(403).json({ error: 'Аккаунт приватный' });
    }

    // Отдаем фронтенду чистые данные
    res.json(data);
    
  } catch (error) {
    console.error('API ERROR:', error.response?.data || error.message);
    if (error.response?.status === 404) return res.status(404).json({ error: 'Аккаунт не найден' });
    res.status(500).json({ error: 'Ошибка сервера при запросе к API' });
  }
});

// Раздача фронтенда
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Minimal Server running on port ${PORT}`));
