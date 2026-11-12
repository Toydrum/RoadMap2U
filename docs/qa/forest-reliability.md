# Comprobaciones de recuperación e instalación

Los probes de navegador en CI usan una compilación local y datos ficticios. La prueba de recuperación usa dos contextos de navegador aislados y reproduce el intercambio con la nube simulada. La prueba del catálogo usa otra compilación con respuestas demoradas o fallidas controladas por el navegador.

## Recorrido con una cuenta dedicada de TEST

Preparar una cuenta dedicada de TEST con Premium de sandbox y un vencimiento controlado. Si el catálogo tiene las compras cerradas, usar una cuenta ya aprovisionada. Iniciar sesión con esa cuenta en dos perfiles limpios y dar a los registros títulos que permitan distinguirlos fácilmente.

1. Crear un árbol con una rama y un pasito en el primer perfil. Revisar el estado en Ajustes y comprobar que el árbol permanece local antes del consentimiento.
2. Autorizar la nube en el primer perfil y sincronizar. Abrir el bosque en el segundo perfil con el permiso correspondiente. Confirmar que aparecen el árbol, la rama y el pasito en el orden correcto.
3. Desconectar el segundo perfil de la red, editar el pasito y volver a cargar la vista instalada. Confirmar que se conserva el cambio local. Reconectar, sincronizar y comprobar que el primer perfil recibe el cambio una sola vez.
4. Usar el vencimiento de Premium configurado para la cuenta de prueba. Comprobar que una edición posterior permanece en el dispositivo y que Ajustes sigue ofreciendo exportar el respaldo.
5. Exportar el respaldo. En un tercer perfil limpio, iniciar sesión con una cuenta de TEST cuya cuota permita importar la copia. Importarla y comparar el árbol, las ramas, los pasitos y el último texto con el primer perfil.

## Teléfono y lector de pantalla

| Dispositivo | Instalación | Lector de pantalla |
| --- | --- | --- |
| iPhone | Safari, Compartir, Agregar a pantalla de inicio | VoiceOver |
| Android | Chrome, menú, Instalar aplicación o Agregar a pantalla de inicio | TalkBack |

1. Abrir Ajustes en el navegador y seguir la opción de instalación. Abrir RoadMap2U desde el icono instalado y comprobar que ya no se ofrece volver a instalarlo.
2. Abrir un árbol de prueba y editar una rama. Usar el tamaño de texto grande. Con el lector de pantalla, localizar la rama desde la lista, abrirla, editarla y cerrar el detalle. Comprobar que se puede continuar desde el mismo control.
3. Con la app instalada en un ambiente de prueba que tenga una nueva versión disponible, abrir Ajustes y buscar actualizaciones. Comprobar que la pantalla sigue disponible mientras la app comprueba la versión.
4. Abrir la ruta que se quiere comprobar y aplicar la actualización desde el aviso. Revisar que conserva la ruta, sus parámetros y el árbol guardado. Repetir desde Ahora cuando haya otra versión disponible y comprobar que retoma la pantalla sin volver a pedir el check-in.
5. Abrir el bosque instalado sin conexión después de haberlo abierto con conexión. Comprobar que se puede leer y editar la rama local.
