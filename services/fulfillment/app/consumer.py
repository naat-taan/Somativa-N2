import json
import os
import time

import pika

QUEUE = "order.created"


def process_order(channel, method, properties, body):
    try:
        order = json.loads(body)
        print(f"Pedido processado: id={order['id']} sku={order['sku']} quantidade={order['quantity']}", flush=True)
        channel.basic_ack(delivery_tag=method.delivery_tag)
    except (ValueError, KeyError) as error:
        print(f"Mensagem invalida descartada: {error}", flush=True)
        channel.basic_nack(delivery_tag=method.delivery_tag, requeue=False)


def main():
    while True:
        try:
            connection = pika.BlockingConnection(pika.URLParameters(os.environ["AMQP_URL"]))
            channel = connection.channel()
            channel.queue_declare(queue=QUEUE, durable=True)
            channel.basic_qos(prefetch_count=1)
            channel.basic_consume(queue=QUEUE, on_message_callback=process_order)
            print(f"Aguardando eventos na fila {QUEUE}", flush=True)
            channel.start_consuming()
        except pika.exceptions.AMQPError as error:
            print(f"RabbitMQ indisponivel: {error}; nova tentativa em 3s", flush=True)
            time.sleep(3)


if __name__ == "__main__":
    main()