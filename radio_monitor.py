import logging
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright


RADIO_URL = "https://www.melodyfm.com.br/aovivo/audio"
CHECK_INTERVAL_SECONDS = 5
STALLED_AFTER_SECONDS = 20
NO_MEDIA_AFTER_SECONDS = 30
PLAY_RETRY_SECONDS = 10
APP_DIR = Path(__file__).resolve().parent
STOP_FILE = APP_DIR / "radio_monitor.stop"
LOG_FILE = APP_DIR / "radio_monitor.log"
PROFILE_DIR = APP_DIR / "browser_profile"

MEDIA_STATUS_SCRIPT = """() => Array.from(document.querySelectorAll('audio, video')).map(media => ({
    currentTime: media.currentTime,
    paused: media.paused,
    ended: media.ended,
    readyState: media.readyState,
    networkState: media.networkState,
    error: media.error ? media.error.code : null
}))"""

PLAY_MEDIA_SCRIPT = """() => {
    const media = Array.from(document.querySelectorAll('audio, video'));
    for (const item of media) {
        if (item.paused || item.ended || item.error) {
            item.play().catch(() => {});
        }
    }
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const playButton = buttons.find(button => {
        const label = `${button.innerText || ''} ${button.getAttribute('aria-label') || ''}`;
        return /play|ouvir|iniciar|reproduzir/i.test(label);
    });
    if (playButton) playButton.click();
    return media.length;
}"""


def configure_logging() -> None:
    handler = RotatingFileHandler(
        LOG_FILE, maxBytes=1_000_000, backupCount=3, encoding="utf-8"
    )
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[handler],
    )


def collect_media_status(page) -> list[tuple[str, dict]]:
    statuses = []
    for frame in page.frames:
        try:
            for media in frame.evaluate(MEDIA_STATUS_SCRIPT):
                statuses.append((frame.url, media))
        except PlaywrightError as error:
            logging.info("Não foi possível consultar um frame (%s): %s", frame.url, error)
    return statuses


def request_play(page) -> None:
    for frame in page.frames:
        try:
            count = frame.evaluate(PLAY_MEDIA_SCRIPT)
            if count:
                logging.info("Solicitada retomada do player.")
                return
        except PlaywrightError as error:
            logging.info("Não foi possível solicitar play no frame (%s): %s", frame.url, error)


def open_radio(page) -> None:
    logging.info("Abrindo %s", RADIO_URL)
    page.goto(RADIO_URL, wait_until="domcontentloaded", timeout=60_000)


def monitor(page) -> None:
    last_progress_at = time.monotonic()
    last_media_seen_at = last_progress_at
    last_play_attempt_at = 0.0
    previous_times: dict[str, float] = {}

    while True:
        if STOP_FILE.exists():
            STOP_FILE.unlink()
            logging.info("Solicitação de encerramento recebida.")
            return

        try:
            statuses = collect_media_status(page)
            now = time.monotonic()
            if statuses:
                last_media_seen_at = now
                is_progressing = False
                for index, (frame_url, media) in enumerate(statuses):
                    key = f"{frame_url}:{index}"
                    current_time = media["currentTime"]
                    previous_time = previous_times.get(key)
                    if previous_time is not None and current_time > previous_time + 0.1:
                        is_progressing = True
                    previous_times[key] = current_time

                if is_progressing:
                    last_progress_at = now
                elif now - last_play_attempt_at >= PLAY_RETRY_SECONDS:
                    request_play(page)
                    last_play_attempt_at = now

                if now - last_progress_at >= STALLED_AFTER_SECONDS:
                    logging.warning("O áudio não avançou; recarregando a página.")
                    open_radio(page)
                    last_progress_at = time.monotonic()
                    last_media_seen_at = last_progress_at
                    previous_times.clear()
                    last_play_attempt_at = 0.0
            elif now - last_media_seen_at >= NO_MEDIA_AFTER_SECONDS:
                logging.warning("Nenhum player de áudio/vídeo encontrado; recarregando a página.")
                open_radio(page)
                last_progress_at = time.monotonic()
                last_media_seen_at = last_progress_at
                previous_times.clear()
                last_play_attempt_at = 0.0
        except PlaywrightError as error:
            logging.error("Falha ao consultar o navegador; tentando recarregar: %s", error)
            open_radio(page)
            last_progress_at = time.monotonic()
            last_media_seen_at = last_progress_at
            previous_times.clear()
            last_play_attempt_at = 0.0

        time.sleep(CHECK_INTERVAL_SECONDS)


def main() -> None:
    configure_logging()
    STOP_FILE.unlink(missing_ok=True)
    logging.info("Monitor da Melody FM iniciado.")

    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            headless=False,
            args=[
                "--start-minimized",
                "--autoplay-policy=no-user-gesture-required",
            ],
        )
        try:
            page = context.pages[0] if context.pages else context.new_page()
            open_radio(page)
            monitor(page)
        finally:
            context.close()

    logging.info("Monitor encerrado.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        logging.info("Monitor interrompido pelo usuário.")
    except PlaywrightError:
        logging.exception(
            "Erro no Playwright. Confira se o Chromium foi instalado com "
            "'python -m playwright install chromium'."
        )
        raise
