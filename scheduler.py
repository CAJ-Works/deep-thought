import logging
import datetime
from apscheduler.schedulers.background import BackgroundScheduler
import database
from database import Thought
from main import enrich_thought_task

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def periodic_enrichment_job():
    """
    Checks the database for any unprocessed thoughts and runs enrichment on them.
    Runs every 2 hours.
    """
    logger.info("Executing periodic thought enrichment check...")
    db = database.SessionLocal()
    try:
        unprocessed_thoughts = db.query(Thought).filter(Thought.processed == False).all()
        if unprocessed_thoughts:
            logger.info(f"Found {len(unprocessed_thoughts)} unprocessed thoughts. Triggering enrichment...")
            for thought in unprocessed_thoughts:
                enrich_thought_task(thought.id)
        else:
            logger.info("No unprocessed thoughts found.")
    except Exception as e:
        logger.error(f"Error during periodic enrichment job: {e}")
    finally:
        db.close()

def nightly_deep_thinking_job():
    """
    Nightly deep thinking job at 2:00 AM.
    Re-runs web research on recent thoughts and updates semantic links.
    """
    logger.info("Starting nightly deep thinking batch job...")
    db = database.SessionLocal()
    try:
        # Get thoughts from the last 7 days to refresh context
        week_ago = datetime.datetime.utcnow() - datetime.timedelta(days=7)
        recent_thoughts = db.query(Thought).filter(Thought.created_at >= week_ago).all()
        
        logger.info(f"Refreshing context and references for {len(recent_thoughts)} thoughts...")
        for thought in recent_thoughts:
            # Force processed to False temporarily to trigger re-enrichment
            thought.processed = False
            db.commit()
            enrich_thought_task(thought.id)
            
        logger.info("Nightly deep thinking batch job completed successfully.")
    except Exception as e:
        logger.error(f"Error during nightly deep thinking job: {e}")
    finally:
        db.close()

def start_scheduler():
    """
    Initializes and starts the background job scheduler.
    """
    scheduler = BackgroundScheduler()
    
    # Run a check every 1 minute
    scheduler.add_job(periodic_enrichment_job, 'interval', minutes=20, id="periodic_check")
    
    # Run nightly research at 2:00 AM every day
    scheduler.add_job(nightly_deep_thinking_job, 'cron', hour=2, id="nightly_job")
    
    scheduler.start()
    logger.info("Background job scheduler started successfully.")
    
    # Trigger an immediate run in the background upon startup to process any stale items in a daemon thread
    import threading
    threading.Thread(target=periodic_enrichment_job, name="startup-enrichment", daemon=True).start()

