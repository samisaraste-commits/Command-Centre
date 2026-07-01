const webpush = require('web-push');

webpush.setVapidDetails(
  'mailto:sami@example.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

module.exports = async function handler(req, res){
  if(req.method !== 'POST'){
    res.status(405).json({error:'Use POST'});
    return;
  }
  try{
    const { subscription, title, body } = req.body;
    if(!subscription){
      res.status(400).json({error:'Missing subscription'});
      return;
    }
    await webpush.sendNotification(subscription, JSON.stringify({
      title: title || 'Command Centre',
      body: body || 'This is a test notification. If you see this, it works.',
      url: '/'
    }));
    res.status(200).json({ok:true});
  }catch(err){
    console.error(err);
    res.status(500).json({error: err.message});
  }
};
