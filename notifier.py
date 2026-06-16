import logging
import requests
import config

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def send_push_notification(message: str) -> bool:
    """
    Sends a push notification to all configured services.
    Returns True if at least one service succeeded, otherwise False.
    """
    success = False
    
    # 1. Telegram
    if config.TELEGRAM_BOT_TOKEN and config.TELEGRAM_CHAT_ID:
        try:
            logger.info("Sending Telegram notification...")
            url = f"https://api.telegram.org/bot{config.TELEGRAM_BOT_TOKEN}/sendMessage"
            payload = {
                "chat_id": config.TELEGRAM_CHAT_ID,
                "text": message
            }
            res = requests.post(url, json=payload, timeout=10)
            if res.status_code == 200:
                success = True
                logger.info("Telegram notification sent successfully.")
            else:
                logger.warning(f"Telegram returned status code {res.status_code}: {res.text}")
        except Exception as e:
            logger.error(f"Failed to send Telegram notification: {e}")
            
    # 2. Ntfy
    if config.NTFY_TOPIC:
        try:
            base_url = config.NTFY_URL.rstrip("/")
            logger.info(f"Sending ntfy notification to topic '{config.NTFY_TOPIC}' on server '{base_url}'...")
            url = f"{base_url}/{config.NTFY_TOPIC}"
            res = requests.post(
                url, 
                data=message.encode("utf-8"), 
                headers={"Title": "Deep Thought Reminder"}, 
                timeout=10
            )
            if res.status_code == 200:
                success = True
                logger.info("Ntfy notification sent successfully.")
            else:
                logger.warning(f"Ntfy returned status code {res.status_code}: {res.text}")
        except Exception as e:
            logger.error(f"Failed to send Ntfy notification: {e}")
            
    # 3. Pushover
    if config.PUSHOVER_USER_KEY and config.PUSHOVER_APP_TOKEN:
        try:
            logger.info("Sending Pushover notification...")
            url = "https://api.pushover.net/1/messages.json"
            payload = {
                "token": config.PUSHOVER_APP_TOKEN,
                "user": config.PUSHOVER_USER_KEY,
                "message": message,
                "title": "Deep Thought Reminder"
            }
            res = requests.post(url, data=payload, timeout=10)
            if res.status_code == 200:
                success = True
                logger.info("Pushover notification sent successfully.")
            else:
                logger.warning(f"Pushover returned status code {res.status_code}: {res.text}")
        except Exception as e:
            logger.error(f"Failed to send Pushover notification: {e}")
            
    # 4. Pushbullet
    if config.PUSHBULLET_API_KEY:
        try:
            logger.info("Sending Pushbullet notification...")
            url = "https://api.pushbullet.com/v2/pushes"
            headers = {
                "Access-Token": config.PUSHBULLET_API_KEY,
                "Content-Type": "application/json"
            }
            payload = {
                "type": "note",
                "title": "Deep Thought Reminder",
                "body": message
            }
            res = requests.post(url, json=payload, headers=headers, timeout=10)
            if res.status_code == 200:
                success = True
                logger.info("Pushbullet notification sent successfully.")
            else:
                logger.warning(f"Pushbullet returned status code {res.status_code}: {res.text}")
        except Exception as e:
            logger.error(f"Failed to send Pushbullet notification: {e}")
            
    if not success:
        logger.warning("No push notification services were successfully dispatched. Verify configuration in your .env file.")
        
    return success
