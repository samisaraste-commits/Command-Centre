const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://wdtcygterxwqqashtqkr.supabase.co';
const CHECKPOINTS = [24, 12, 10, 8, 6, 4, 2, 0]; // hours-before-due, descending; 0 = expired

function db(){
  return createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function sendTelegram(text){
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
}

function helsinkiNow(){
  // Convert current UTC time to a Date object representing Helsinki wall-clock time
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Helsinki', hour12: false,
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'
  });
  const parts = {};
  fmt.formatToParts(new Date()).forEach(p => { parts[p.type] = p.value; });
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parseInt(parts.hour, 10)
  };
}

async function checkTodoReminders(supa, userId){
  const now = new Date();
  const { data: todos, error } = await supa
    .from('todos')
    .select('*')
    .eq('user_id', userId)
    .eq('done', false)
    .not('due_at', 'is', null);
  if(error){ console.error('todo fetch error', error); return; }

  for(const t of todos){
    const due = new Date(t.due_at);
    const hoursLeft = (due.getTime() - now.getTime()) / 3600000;
    const lastSent = (t.last_checkpoint_sent === null || t.last_checkpoint_sent === undefined) ? Infinity : t.last_checkpoint_sent;
    const reached = CHECKPOINTS.filter(c => c >= hoursLeft && c < lastSent);
    if(reached.length === 0) continue;
    const checkpoint = Math.min(...reached); // most advanced (closest to due) unsent checkpoint

    let msg;
    if(checkpoint === 0){
      msg = `⏰ <b>Overdue:</b> "${t.text}" was due just now. Want to knock it out right now?`;
    } else {
      msg = `⏳ <b>${checkpoint}h left</b> — "${t.text}" is due soon.`;
    }
    await sendTelegram(msg);
    await supa.from('todos').update({ last_checkpoint_sent: checkpoint }).eq('id', t.id);
  }
}

async function maybeSendDigest(supa, userId){
  const { dateStr, hour } = helsinkiNow();
  if(hour !== 10) return; // only fires in the 10:00 Helsinki hour

  const { data: state } = await supa.from('automation_state').select('*').eq('id', 1).single();
  if(state && state.last_digest_date === dateStr) return; // already sent today

  const startOfToday = new Date(`${dateStr}T00:00:00+00:00`); // approx boundary is fine for a daily digest
  const yesterday = new Date(startOfToday.getTime() - 86400000);

  const [{ data: doneYesterday }, { data: dueToday }, { data: projects }, { data: mantraRow }] = await Promise.all([
    supa.from('todos').select('*').eq('user_id', userId).eq('done', true)
      .gte('completed_at', yesterday.toISOString()).lt('completed_at', startOfToday.toISOString()),
    supa.from('todos').select('*').eq('user_id', userId).eq('done', false)
      .not('due_at', 'is', null).gte('due_at', `${dateStr}T00:00:00`).lt('due_at', `${dateStr}T23:59:59`),
    supa.from('projects').select('*').eq('user_id', userId).eq('archived', false),
    supa.from('mantras').select('*').eq('user_id', userId).limit(1).maybeSingle()
  ]);

  let msg = `☀️ <b>Good morning — 10am check-in</b>\n\n`;

  msg += `<b>Done yesterday</b> (${(doneYesterday||[]).length})\n`;
  msg += (doneYesterday && doneYesterday.length) ? doneYesterday.map(t=>`✓ ${t.text}`).join('\n') : '— nothing logged';
  msg += `\n\n<b>Due today</b> (${(dueToday||[]).length})\n`;
  msg += (dueToday && dueToday.length) ? dueToday.map(t=>`• ${t.text}`).join('\n') : '— nothing due';
  msg += `\n\n<b>Open projects</b> (${(projects||[]).length})\n`;
  msg += (projects && projects.length) ? projects.map(p=>`• ${p.name} (${p.due||'no deadline'})`).join('\n') : '— none';

  const mantraLines = (mantraRow && mantraRow.text) ? mantraRow.text.split('\n').filter(Boolean) : [];
  msg += `\n\n<b>Mantras</b>\n`;
  msg += mantraLines.length ? mantraLines.map(m=>`✦ ${m}`).join('\n') : '— none set';

  await sendTelegram(msg);
  await supa.from('automation_state').upsert({ id: 1, last_digest_date: dateStr });
}

module.exports = async function handler(req, res){
  try{
    const userId = process.env.COMMAND_CENTRE_USER_ID;
    if(!userId){ res.status(500).json({error:'COMMAND_CENTRE_USER_ID not set'}); return; }
    const supa = db();
    await checkTodoReminders(supa, userId);
    await maybeSendDigest(supa, userId);
    res.status(200).json({ok:true, checkedAt: new Date().toISOString()});
  }catch(err){
    console.error(err);
    res.status(500).json({error: err.message});
  }
};
