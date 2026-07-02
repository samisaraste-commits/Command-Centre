module.exports = async function handler(req, res){
  if(req.method !== 'POST'){
    res.status(405).json({error:'Use POST'});
    return;
  }
  try{
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if(!token || !chatId){
      res.status(500).json({error:'Bot not configured yet'});
      return;
    }
    const message = (req.body && req.body.message) || 'Test notification from Command Centre — if you see this, it works!';
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id: chatId, text: message })
    });
    const data = await r.json();
    if(!data.ok){
      res.status(500).json({error: data.description || 'Telegram send failed'});
      return;
    }
    res.status(200).json({ok:true});
  }catch(err){
    console.error(err);
    res.status(500).json({error: err.message});
  }
};
